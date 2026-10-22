import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ContactChannel,
  OutboundMessageStatus,
  type Prisma,
} from '../../generated/cnc-client';
import { CncConfigService } from '../config/cnc.config';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { frameCncMail } from './cnc-mail-frame';
import {
  type MailTemplateName,
  type MailTemplateParams,
  renderMail,
} from './mail-templates';
import { MAIL_TRANSPORT, type MailTransport } from './mail-transport';
import { MessageSeal } from './message-seal';

/** Sends a message gets before it is given up (plan §5.5: 3 attempts). */
export const MESSAGE_MAX_ATTEMPTS = 3;

/**
 * How long a message waits for a send by default, from when it is queued.
 * A confirmation that arrives days late is worse than none, and without a
 * limit a staging service with no mail key would build a backlog that all
 * goes out the day the key is set. A caller with a shorter useful life (a
 * sign-in code) passes its own.
 */
export const MESSAGE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** How many messages one sweep run tries, oldest first. */
export const MESSAGE_SWEEP_BATCH = 50;

/** `lastError` while mail is not configured: the message is still waiting. */
export const MAIL_NOT_CONFIGURED = 'Mail is not configured.';

/** `lastError` of a message whose time ran out before a send succeeded. */
export const MESSAGE_EXPIRED = 'Expired before it could be sent.';

/** `lastError` of a message whose payload could not be read back. */
export const MESSAGE_UNREADABLE =
  'The message could not be read back to send it.';

/** A Prisma client or a transaction's, for `enqueue`. */
type MessageWriter = Pick<Prisma.TransactionClient, 'outboundMessage'>;

/** One message to queue. */
export interface QueuedEmail<Name extends MailTemplateName> {
  to: string;
  template: Name;
  params: MailTemplateParams[Name];
  /**
   * Makes the event enqueue at most one message however often it runs:
   * `otp:<OtpCode.id>`, `reservation:<id>:confirmed` and so on.
   */
  dedupeKey: string;
  /** When to give up. Defaults to `MESSAGE_DEFAULT_TTL_MS` from now. */
  expiresAt?: Date;
}

/** What one run of the messages sweep did. */
export interface MessagesSweepResult {
  sent: number;
  failed: number;
  waiting: number;
  expired: number;
}

type DispatchOutcome = 'sent' | 'failed' | 'waiting' | 'expired' | 'skipped';

/**
 * The outbound queue (plan §4.8, §9.2): every email CNC sends is written as
 * an `OutboundMessage` in the command's own transaction, then sent after the
 * commit. **A failed send never rolls back the command and never fails the
 * request**: the customer who asked for a code gets their answer, and the
 * message waits for the retry sweep (`POST /internal/sweeps/messages`).
 *
 * - `enqueue(tx, …)` writes the row, with the template's parameters sealed
 *   (`MessageSeal`), inside the caller's transaction. A dedupe key that is
 *   already queued writes nothing and answers the existing row.
 * - `dispatch(id)` sends one queued message after the commit. It never
 *   throws.
 * - `sweep(now)` retries waiting and failed messages, three attempts each,
 *   and gives up on those past `expiresAt`.
 *
 * A message is claimed before it is sent, by a conditional increment of
 * `attempts`, so the request's own dispatch and a sweep running at the same
 * moment cannot both send it. While the transport is not configured (no key
 * on staging yet) the message stays `PENDING` and no attempt is spent.
 *
 * **Logs carry the recipient and the outcome only**: never a subject, a
 * body or a parameter, because a sign-in code is all three.
 */
@Injectable()
export class OutboundMessagesService {
  private readonly logger = new Logger(OutboundMessagesService.name);

  constructor(
    private readonly prisma: CncPrismaService,
    private readonly seal: MessageSeal,
    private readonly config: CncConfigService,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  /**
   * Queue an email in the caller's transaction and return its id, for
   * `dispatch` after the commit.
   *
   * The message is rendered once here and thrown away, so a template whose
   * parameters do not fit fails the command now, not silently in a sweep.
   */
  async enqueue<Name extends MailTemplateName>(
    tx: MessageWriter,
    message: QueuedEmail<Name>,
  ): Promise<string> {
    renderMail(message.template, message.params);

    await tx.outboundMessage.createMany({
      data: [
        {
          channel: ContactChannel.EMAIL,
          to: message.to,
          template: message.template,
          dedupeKey: message.dedupeKey,
          payload: this.seal.seal(message.params),
          expiresAt:
            message.expiresAt ?? new Date(Date.now() + MESSAGE_DEFAULT_TTL_MS),
        },
      ],
      // ON CONFLICT DO NOTHING: a repeat of the same event queues nothing,
      // and a clash does not abort the caller's transaction as a P2002 would.
      skipDuplicates: true,
    });

    const row = await tx.outboundMessage.findUniqueOrThrow({
      where: { dedupeKey: message.dedupeKey },
      select: { id: true },
    });

    return row.id;
  }

  /**
   * Give up, in the caller's transaction, every message still waiting for
   * `to`: its payload is cleared and the sweep never sends it. For an
   * address that must receive nothing more (a deleted account, Q36).
   * Returns how many were given up.
   */
  async abandonTo(
    tx: MessageWriter,
    to: string,
    reason: string,
  ): Promise<number> {
    const { count } = await tx.outboundMessage.updateMany({
      where: {
        to,
        status: {
          in: [OutboundMessageStatus.PENDING, OutboundMessageStatus.FAILED],
        },
        payload: { not: null },
      },
      data: {
        status: OutboundMessageStatus.FAILED,
        payload: null,
        lastError: reason,
      },
    });

    return count;
  }

  /**
   * Send one queued message now. Never throws: whatever happens is recorded
   * on the row, and the sweep takes it from there.
   */
  async dispatch(id: string): Promise<void> {
    try {
      await this.dispatchOne(id, new Date());
    } catch (error) {
      // A database failure while recording the outcome. The row is still
      // PENDING or FAILED with its payload, so the sweep retries it.
      this.logger.error(
        `Outbound message ${id} could not be dispatched: ` +
          `${error instanceof Error ? error.name : 'unknown error'}.`,
      );
    }
  }

  /**
   * The messages sweep: give up on what has expired, then retry what is
   * waiting or failed, oldest first, `MESSAGE_SWEEP_BATCH` at a time.
   */
  async sweep(now: Date): Promise<MessagesSweepResult> {
    const result: MessagesSweepResult = {
      sent: 0,
      failed: 0,
      waiting: 0,
      expired: 0,
    };

    const expired = await this.prisma.outboundMessage.updateMany({
      where: {
        status: {
          in: [OutboundMessageStatus.PENDING, OutboundMessageStatus.FAILED],
        },
        payload: { not: null },
        expiresAt: { lte: now },
      },
      data: {
        status: OutboundMessageStatus.FAILED,
        payload: null,
        lastError: MESSAGE_EXPIRED,
      },
    });
    result.expired = expired.count;

    const due = await this.prisma.outboundMessage.findMany({
      where: {
        status: {
          in: [OutboundMessageStatus.PENDING, OutboundMessageStatus.FAILED],
        },
        payload: { not: null },
        attempts: { lt: MESSAGE_MAX_ATTEMPTS },
      },
      orderBy: { createdAt: 'asc' },
      take: MESSAGE_SWEEP_BATCH,
      select: { id: true },
    });

    for (const { id } of due) {
      const outcome = await this.dispatchOne(id, now).catch(
        (): DispatchOutcome => 'skipped',
      );

      if (outcome === 'sent') result.sent += 1;
      else if (outcome === 'failed') result.failed += 1;
      else if (outcome === 'waiting') result.waiting += 1;
      else if (outcome === 'expired') result.expired += 1;
    }

    return result;
  }

  private async dispatchOne(id: string, now: Date): Promise<DispatchOutcome> {
    const row = await this.prisma.outboundMessage.findUnique({
      where: { id },
      select: {
        id: true,
        to: true,
        template: true,
        status: true,
        attempts: true,
        payload: true,
        expiresAt: true,
      },
    });

    if (
      row === null ||
      row.status === OutboundMessageStatus.SENT ||
      row.payload === null ||
      row.attempts >= MESSAGE_MAX_ATTEMPTS
    ) {
      return 'skipped';
    }

    if (row.expiresAt !== null && row.expiresAt <= now) {
      await this.giveUp(row.id, MESSAGE_EXPIRED);
      return 'expired';
    }

    let mail: { subject: string; html: string; text: string };

    try {
      const rendered = renderMail(row.template, this.seal.open(row.payload));
      mail = {
        subject: rendered.subject,
        html: frameCncMail({
          html: rendered.html,
          logoUrl: this.config.buildWebUrl('/icons/icon-192.png'),
        }),
        text: rendered.text,
      };
    } catch {
      await this.giveUp(row.id, MESSAGE_UNREADABLE);
      this.logger.error(
        `Outbound message ${row.id} to ${row.to} was given up: its ` +
          'payload could not be read back.',
      );
      return 'failed';
    }

    if (!this.transport.configured) {
      await this.prisma.outboundMessage.updateMany({
        where: { id: row.id, status: { not: OutboundMessageStatus.SENT } },
        data: { lastError: MAIL_NOT_CONFIGURED },
      });
      this.logger.warn(
        `Mail to ${row.to} is queued: mail is not configured on this service.`,
      );
      return 'waiting';
    }

    // The claim: only the caller whose increment lands sends the message.
    const claimed = await this.prisma.outboundMessage.updateMany({
      where: {
        id: row.id,
        attempts: row.attempts,
        status: {
          in: [OutboundMessageStatus.PENDING, OutboundMessageStatus.FAILED],
        },
      },
      data: { attempts: { increment: 1 } },
    });

    if (claimed.count !== 1) {
      return 'skipped';
    }

    try {
      // Replies reach CNC's inbox (`CNC_CONTACT_EMAIL`): the sender
      // address only sends (the founder's Q19 note, 2026-10-22).
      await this.transport.send({
        to: row.to,
        ...mail,
        replyTo: this.config.contactEmail,
      });
    } catch (error) {
      const attempts = row.attempts + 1;
      const reason =
        error instanceof Error ? error.message.slice(0, 500) : 'Send failed.';

      await this.prisma.outboundMessage.update({
        where: { id: row.id },
        data: {
          status: OutboundMessageStatus.FAILED,
          lastError: reason,
          // The last attempt spent: nothing will read the payload again.
          ...(attempts >= MESSAGE_MAX_ATTEMPTS ? { payload: null } : {}),
        },
      });
      this.logger.warn(
        `Mail to ${row.to} failed (attempt ${attempts} of ` +
          `${MESSAGE_MAX_ATTEMPTS}).`,
      );
      return 'failed';
    }

    await this.prisma.outboundMessage.update({
      where: { id: row.id },
      data: {
        status: OutboundMessageStatus.SENT,
        sentAt: new Date(),
        lastError: null,
        payload: null,
      },
    });

    return 'sent';
  }

  private async giveUp(id: string, reason: string): Promise<void> {
    await this.prisma.outboundMessage.updateMany({
      where: { id, status: { not: OutboundMessageStatus.SENT } },
      data: {
        status: OutboundMessageStatus.FAILED,
        payload: null,
        lastError: reason,
      },
    });
  }
}
