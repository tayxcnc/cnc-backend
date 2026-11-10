import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ContactChannel,
  OutboundMessageStatus,
  type Prisma,
} from '../../generated/cnc-client';
import { retryAfterBackoff } from '../common/retry-backoff';
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
import { isReservedMailDomain } from './reserved-mail-domains';

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

/**
 * The backoff after a failed send, by how many attempts are spent: the
 * sweep leaves the message alone for 5 minutes after the first failure and
 * 30 after the second (C6-8). The sweep runs every 5 minutes, so without a
 * wait one short provider outage would spend all three attempts in a
 * quarter of an hour; with it the three are spread over more than half an
 * hour, still well inside the default day a message may wait.
 */
export const MESSAGE_RETRY_BACKOFF_MS = [5 * 60 * 1000, 30 * 60 * 1000];

/**
 * When a message whose send has just failed may be tried again, after
 * `attempts` spent. Past the last listed wait the last one repeats; a
 * message that has spent every attempt is never tried again anyway.
 */
export function retryAfterFor(attempts: number, now: Date): Date {
  return retryAfterBackoff(MESSAGE_RETRY_BACKOFF_MS, attempts, now);
}

/**
 * How long a claimed message is left alone while its send is in flight
 * (`retryAfter` set at the claim). Longer than the transport's own limit on
 * a send (`MAIL_SEND_TIMEOUT_MS`), so a sweep never claims a message whose
 * first send may still succeed; short enough that a send lost with its
 * process is retried by the next sweep but one.
 */
export const MESSAGE_SEND_LEASE_MS = 2 * 60 * 1000;

/** `lastError` while mail is not configured: the message is still waiting. */
export const MAIL_NOT_CONFIGURED = 'Mail is not configured.';

/** `lastError` of a message whose time ran out before a send succeeded. */
export const MESSAGE_EXPIRED = 'Expired before it could be sent.';

/**
 * `lastError` of a message to a reserved domain, given up unsent on a
 * transport that reaches real inboxes (`isReservedMailDomain`, C8 review).
 */
export const MESSAGE_RESERVED_DOMAIN =
  'Not sent: the address is at a reserved domain that cannot receive mail.';

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
 *   a failed one only once its backoff has passed (`retryAfter`, 5 then 30
 *   minutes), and gives up on those past `expiresAt`.
 *
 * A message is claimed before it is sent, by a conditional increment of
 * `attempts` that also leases it (`retryAfter` moved `MESSAGE_SEND_LEASE_MS`
 * ahead), so the request's own dispatch and a sweep cannot both send it,
 * whether they arrive together or one starts while the other's send is in
 * flight. A failure is recorded only by the claim that made it and never
 * over a delivery. While the transport is not configured (no key
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
   * Forget, in the caller's transaction, every message about a person who
   * must be forgotten (a deleted account, Q36): those sent to `to`, and
   * those whose dedupe key is one of `keys` or starts with one of
   * `keyPrefixes` (their bookings' and codes' messages, which reach earlier
   * addresses too). A message still waiting is given up with `reason` and
   * the sweep never sends it; every one loses its recipient and its
   * payload, so no row ties a kept record (a booking named in a dedupe key)
   * back to the person's address. Returns how many were forgotten.
   */
  async forget(
    tx: MessageWriter,
    match: { to: string | null; keys: string[]; keyPrefixes: string[] },
    reason: string,
  ): Promise<number> {
    const where: Prisma.OutboundMessageWhereInput = {
      OR: [
        ...(match.to === null ? [] : [{ to: match.to }]),
        ...(match.keys.length === 0 ? [] : [{ dedupeKey: { in: match.keys } }]),
        ...match.keyPrefixes.map((prefix) => ({
          dedupeKey: { startsWith: prefix },
        })),
      ],
    };

    if ((where.OR as unknown[]).length === 0) return 0;

    await tx.outboundMessage.updateMany({
      where: {
        AND: [
          where,
          {
            status: {
              in: [OutboundMessageStatus.PENDING, OutboundMessageStatus.FAILED],
            },
            payload: { not: null },
          },
        ],
      },
      data: { status: OutboundMessageStatus.FAILED, lastError: reason },
    });

    const { count } = await tx.outboundMessage.updateMany({
      where,
      data: { to: '', payload: null },
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
   * Send the message queued under `dedupeKey`, if any, now. For a command
   * run through `IdempotencyService`, whose work cannot hand the message id
   * out past a replay: a replay finds the message already sent and sends
   * nothing. Never throws.
   */
  async dispatchByKey(dedupeKey: string): Promise<void> {
    try {
      const row = await this.prisma.outboundMessage.findUnique({
        where: { dedupeKey },
        select: { id: true },
      });

      if (row !== null) await this.dispatch(row.id);
    } catch (error) {
      this.logger.error(
        `Outbound message ${dedupeKey} could not be found to dispatch: ` +
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
        // A failed message waits out its backoff (`retryAfterFor`).
        OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
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
        retryAfter: true,
      },
    });

    if (
      row === null ||
      row.status === OutboundMessageStatus.SENT ||
      row.payload === null ||
      row.attempts >= MESSAGE_MAX_ATTEMPTS ||
      // Still backing off after a failure, whoever asks (a replayed
      // command's dispatch included).
      (row.retryAfter !== null && row.retryAfter > now)
    ) {
      return 'skipped';
    }

    if (row.expiresAt !== null && row.expiresAt <= now) {
      await this.giveUp(row.id, MESSAGE_EXPIRED);
      return 'expired';
    }

    // No provider call, no attempt: a reserved domain can only bounce, and
    // a bounce spends CNC's quota and its sending domain's standing (the
    // load test's `@example.com` guests on staging).
    if (this.transport.deliversToInboxes && isReservedMailDomain(row.to)) {
      await this.giveUp(row.id, MESSAGE_RESERVED_DOMAIN);
      this.logger.warn(
        `Mail to ${row.to} was given up: a reserved domain cannot receive mail.`,
      );
      return 'failed';
    }

    let mail: { subject: string; html: string; text: string; replyTo?: string };

    try {
      const rendered = renderMail(row.template, this.seal.open(row.payload));
      mail = {
        subject: rendered.subject,
        html: frameCncMail({
          html: rendered.html,
          logoUrl: this.config.buildWebUrl('/icons/icon-192.png'),
        }),
        text: rendered.text,
        // Replies reach CNC's inbox (`CNC_CONTACT_EMAIL`): the sender
        // address only sends (the founder's Q19 note, 2026-10-22). A
        // template may name its own (an enquiry: the person who wrote).
        replyTo: rendered.replyTo ?? this.config.contactEmail,
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

    // The claim, as a lease: only the caller whose increment lands sends
    // the message, and `retryAfter` moves past the send's longest wait, so
    // no sweep picks the row up while the send is still in flight (every
    // reader skips a row whose `retryAfter` is ahead). A process that dies
    // mid-send leaves the lease to run out, and the sweep tries again.
    const attempts = row.attempts + 1;
    const claimed = await this.prisma.outboundMessage.updateMany({
      where: {
        id: row.id,
        attempts: row.attempts,
        status: {
          in: [OutboundMessageStatus.PENDING, OutboundMessageStatus.FAILED],
        },
        OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
      },
      data: {
        attempts: { increment: 1 },
        retryAfter: new Date(now.getTime() + MESSAGE_SEND_LEASE_MS),
      },
    });

    if (claimed.count !== 1) {
      return 'skipped';
    }

    try {
      await this.transport.send({
        to: row.to,
        ...mail,
        // The row's id: a retry after a send whose answer was lost (a
        // timeout) is recognised by the provider and not delivered twice.
        idempotencyKey: `cnc-outbound-${row.id}`,
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message.slice(0, 500) : 'Send failed.';

      // Only while this claim is the latest and nothing has marked the
      // message sent: a late failure never overwrites a delivery.
      await this.prisma.outboundMessage.updateMany({
        where: {
          id: row.id,
          attempts,
          status: { not: OutboundMessageStatus.SENT },
        },
        data: {
          status: OutboundMessageStatus.FAILED,
          lastError: reason,
          // The last attempt spent: nothing will read the payload again.
          ...(attempts >= MESSAGE_MAX_ATTEMPTS
            ? { payload: null, retryAfter: null }
            : { retryAfter: retryAfterFor(attempts, now) }),
        },
      });
      this.logger.warn(
        `Mail to ${row.to} failed (attempt ${attempts} of ` +
          `${MESSAGE_MAX_ATTEMPTS}).`,
      );
      return 'failed';
    }

    // A delivery is a fact whichever claim made it.
    await this.prisma.outboundMessage.updateMany({
      where: { id: row.id, status: { not: OutboundMessageStatus.SENT } },
      data: {
        status: OutboundMessageStatus.SENT,
        sentAt: new Date(),
        lastError: null,
        payload: null,
        retryAfter: null,
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
