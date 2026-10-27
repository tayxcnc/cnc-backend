import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type Prisma,
  PushDropReason,
  PushMessageStatus,
} from '../../generated/cnc-client';
import { retryAfterBackoff } from '../common/retry-backoff';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import {
  type CustomerPushEvent,
  type CustomerPushInputs,
  isPushEvent,
  MAX_PUSH_TTL_S,
  MIN_PUSH_TTL_S,
  PUSH_CATALOGUE,
  type PushEvent,
  type PushInputs,
  pushExpiresAt,
  type RenderedPush,
  renderPush,
  roleReceives,
  type StaffPushEvent,
  type StaffPushInputs,
} from './push-catalogue';
import { holdUntil } from './push-window';
import {
  type StaffRecipientSelector,
  staffRecipients,
} from './push-recipients';
import { withPushSavepoint } from './push-savepoint';
import { PUSH_SENDER, type PushOutcome, type PushSender } from './push-sender';

/** Each request's or confirmation's whole budget for sending its pushes. */
export const PUSH_DISPATCH_BUDGET_MS = 3_000;

/** One push sweep run's whole budget for sending. */
export const PUSH_SWEEP_BUDGET_MS = 30_000;

/**
 * How long a claimed push is left alone while its sends are in flight
 * (`retryAfter` set at the claim). Longer than any budget, and every send's
 * timeout is the budget's remainder, so a send never outlives its lease and
 * a second sweep never claims a push still in flight.
 */
export const PUSH_LEASE_MS = 60_000;

/** Sends a push gets before it is given up. */
export const PUSH_MAX_ATTEMPTS = 3;

/**
 * The wait after a failed send, by attempts spent: a minute after the
 * first, five after the second. Short, because a push is about now: an
 * order ready for pickup is no news an hour later. The push sweep runs every
 * five minutes, so the waits are floors.
 */
export const PUSH_RETRY_BACKOFF_MS = [60_000, 300_000];

/** How many pushes one sweep run tries, oldest first. */
export const PUSH_SWEEP_BATCH = 100;

/** How many pushes are sent at once. */
export const DELIVERY_CONCURRENCY = 10;

// A send's timeout is at most the budget left, and the lease must outlast
// the longest budget, or a sweep could claim a push still being sent.
if (PUSH_SWEEP_BUDGET_MS >= PUSH_LEASE_MS) {
  throw new Error('PUSH_SWEEP_BUDGET_MS must be below PUSH_LEASE_MS.');
}

/** The longest topic and dedupe key the columns hold. */
const TOPIC_MAX = 200;
const DEDUPE_KEY_MAX = 300;

/** When a push whose send has just failed may be tried again. */
export function pushRetryAfter(attempts: number, now: Date): Date {
  return retryAfterBackoff(PUSH_RETRY_BACKOFF_MS, attempts, now);
}

/**
 * An event's input, or a function that builds it. The builder runs inside
 * the queue's own `try`, so a brand constructor refusing a value (an id
 * of the wrong shape) costs the push, never the event (D1). Call sites
 * pass a builder whenever building the input can throw.
 */
export type PushInput<I> = I | (() => I);

/**
 * The topics one request's commands queued, for one `dispatchTopics` after
 * the commit (D14). A null is a write that queued nothing. A command that
 * runs inside its caller's transaction (the idempotency service's) adds to
 * the caller's list, which dispatches once the transaction has committed;
 * a replay runs no work, adds nothing and sends nothing again.
 */
export type PushTopics = (string | null)[];

/** What one run of the queue's sweep did. */
export interface PushQueueSweepResult {
  /** Delivered to at least one device. */
  sent: number;
  /** Failed this run, to be tried again after the backoff. */
  failed: number;
  /** Given up this run: no device, recipient gone, rejected, attempts spent. */
  dropped: number;
  /** Given up because their time ran out before a send succeeded. */
  expired: number;
  /** Left waiting because push is not configured on this service. */
  waiting: number;
  /**
   * Staff pushes still held for the staff window (D6) when the run ended:
   * never tried, with a release time still ahead.
   */
  held: number;
}

type DispatchOutcome =
  'sent' | 'failed' | 'dropped' | 'expired' | 'waiting' | 'skipped';

const OPEN_STATUSES = [PushMessageStatus.PENDING, PushMessageStatus.FAILED];

/** What a push's dispatch reads of its row. */
const DISPATCH_SELECT = {
  id: true,
  customerId: true,
  staffId: true,
  event: true,
  title: true,
  body: true,
  link: true,
  ref: true,
  tag: true,
  urgent: true,
  renotify: true,
  status: true,
  attempts: true,
  retryAfter: true,
  expiresAt: true,
} as const;

type DispatchRow = Prisma.PushMessageGetPayload<{
  select: typeof DISPATCH_SELECT;
}>;

/**
 * The web push queue (C10, spec §2.4): pushes written in the event's own
 * transaction, sent after it commits, retried by the push sweep.
 *
 * ## Writing: `enqueueCustomer` and `enqueueStaff`
 *
 * Called inside the event's transaction, beside the in-app item or the
 * email it accompanies. **They never throw and never fail the event** (D1):
 * the pure part (render, clip, topic, tag, expiry) runs in a `try` that
 * answers null, and the database part (the gate or switch, the recipients,
 * whether anyone holds a device, the insert) runs inside
 * `withPushSavepoint`, which rolls back only itself. Rows are written only
 * for people with at least one device (D3), one per person, keyed by
 * `dedupeKey` with `skipDuplicates`, so a retried command or a second
 * webhook writes nothing new. Each answers the topic to dispatch, or null.
 *
 * ## Sending: `dispatchTopics`, `sweep` and `dispatchOne`
 *
 * After the commit, a request awaits `dispatchTopics` with one shared
 * deadline (D14: Cloud Run throttles the CPU once the response is sent, so
 * nothing is fire-and-forget); whatever is left goes to the push sweep. A
 * push is claimed before it is sent, by a conditional increment of
 * `attempts` that also leases it, so a request and a sweep never both send
 * it. The recipient is checked again at send (D11). Every device the
 * person holds is tried at once; a gone device, or one subscribed with
 * another key (D12), is deleted. While push is not configured (local, no
 * keys) the push waits and spends no attempt, as the mail queue's
 * "not configured" rule.
 *
 * **Logs carry ids, counts, statuses and drop reasons only**: never an
 * endpoint, a key or a push's text.
 */
@Injectable()
export class PushQueueService {
  private readonly logger = new Logger(PushQueueService.name);

  constructor(
    private readonly prisma: CncPrismaService,
    @Inject(PUSH_SENDER) private readonly sender: PushSender,
  ) {}

  /**
   * Queue a customer's push inside the event's transaction. Answers the
   * topic to dispatch after the commit, or null when nothing was queued:
   * the customer is gone or deleted, switched the event's gate off, holds
   * no device, or something failed (logged, never thrown).
   */
  async enqueueCustomer<E extends CustomerPushEvent>(
    tx: Prisma.TransactionClient,
    event: E,
    customerId: string,
    input: PushInput<CustomerPushInputs[E]>,
  ): Promise<string | null> {
    try {
      const now = new Date();
      const prepared = this.prepare(event, input, now, 'c', [customerId]);

      if (prepared === null) return null;

      const entry = PUSH_CATALOGUE[event];
      const { push, expiresAt } = prepared;

      const written = await withPushSavepoint(
        tx,
        `${event} for customer ${customerId}`,
        async () => {
          const customer = await tx.customer.findUnique({
            where: { id: customerId },
            select: {
              deletedAt: true,
              prefOrderUpdates: true,
              prefBookingReminders: true,
            },
          });

          if (customer === null || customer.deletedAt !== null) return false;
          if (entry.gate !== undefined && !customer[entry.gate]) return false;

          const devices = await tx.customerPushSubscription.count({
            where: { customerId },
          });

          if (devices === 0) return false;

          await tx.pushMessage.createMany({
            data: [
              {
                ...this.columns(event, push),
                customerId,
                dedupeKey: dedupeKeyOf(event, push.about, 'c', customerId),
                expiresAt,
              },
            ],
            skipDuplicates: true,
          });

          return true;
        },
      );

      return written === true ? push.about : null;
    } catch (error) {
      this.notQueued(event, error);
      return null;
    }
  }

  /**
   * Queue a staff push inside the event's transaction: one row for each
   * recipient (`staffRecipients`, D8) who holds a device, unless the
   * event's alert switch is off. A non-urgent push to someone off duty
   * outside the staff window is held to the window's opening (D6), and its
   * expiry runs from then. Answers the topic, or null as `enqueueCustomer`.
   */
  async enqueueStaff<E extends StaffPushEvent>(
    tx: Prisma.TransactionClient,
    event: E,
    input: PushInput<StaffPushInputs[E]>,
    recipients: StaffRecipientSelector,
  ): Promise<string | null> {
    try {
      const now = new Date();
      const prepared = this.prepare(event, input, now, 's', [
        // The longest an owner id can make the key: a cuid is 25.
        'x'.repeat(32),
      ]);

      if (prepared === null) return null;

      const entry = PUSH_CATALOGUE[event];
      const { push, built } = prepared;

      const written = await withPushSavepoint(
        tx,
        `${event} for staff`,
        async () => {
          if (entry.alert !== undefined) {
            const settings = await tx.settings.findUnique({
              where: { singleton: true },
              select: {
                alertApprovals: true,
                alertLowStock: true,
                alertUnsettled: true,
                alertArrivals: true,
              },
            });

            if (settings !== null && !settings[entry.alert]) return false;
          }

          const people = await staffRecipients(tx, {
            ...recipients,
            event,
            now,
          });

          if (people.length === 0) return false;

          const holders = new Set(
            (
              await tx.staffPushSubscription.findMany({
                where: { staffId: { in: people.map(({ id }) => id) } },
                select: { staffId: true },
                distinct: ['staffId'],
              })
            ).map(({ staffId }) => staffId),
          );
          const reached = people.filter(({ id }) => holders.has(id));

          if (reached.length === 0) return false;

          // The week's hours, only when someone could be held.
          const days =
            !push.urgent && reached.some(({ onDuty }) => !onDuty)
              ? await tx.openingHoursDay.findMany({
                  select: {
                    dayOfWeek: true,
                    isClosed: true,
                    opensAtMinutes: true,
                    closesAtMinutes: true,
                  },
                })
              : null;

          await tx.pushMessage.createMany({
            data: reached.map(({ id, onDuty }) => {
              const retryAfter = holdUntil({
                urgent: push.urgent,
                onDuty,
                days,
                now,
              });

              return {
                ...this.columns(event, push),
                staffId: id,
                dedupeKey: dedupeKeyOf(event, push.about, 's', id),
                retryAfter,
                expiresAt: pushExpiresAt<PushEvent>(
                  event,
                  built,
                  retryAfter ?? now,
                ),
              };
            }),
            skipDuplicates: true,
          });

          return true;
        },
      );

      return written === true ? push.about : null;
    } catch (error) {
      this.notQueued(event, error);
      return null;
    }
  }

  /**
   * Send the waiting pushes of `topics` now, after the commit, until
   * `deadline` (epoch milliseconds; one per request, shared by every
   * dispatch in it). Awaited, never throws. Held and backing-off pushes are
   * left alone, and nothing new starts after the deadline: what is left is
   * the push sweep's. A null topic (a write that queued nothing) is
   * skipped.
   */
  async dispatchTopics(
    queued: readonly (string | null)[],
    deadline: number = Date.now() + PUSH_DISPATCH_BUDGET_MS,
  ): Promise<void> {
    const topics = [
      ...new Set(queued.filter((topic): topic is string => topic !== null)),
    ];

    if (topics.length === 0) return;

    try {
      const now = new Date();
      const due = await this.prisma.pushMessage.findMany({
        where: {
          topic: { in: topics },
          status: PushMessageStatus.PENDING,
          OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });

      await this.dispatchAll(
        due.map(({ id }) => id),
        deadline,
        now,
      );
    } catch (error) {
      this.logger.error(
        `Pushes for ${topics.length} topic(s) could not be dispatched: ` +
          `${error instanceof Error ? error.name : 'unknown error'}. The push ` +
          'sweep retries them.',
      );
    }
  }

  /**
   * The queue's part of the push sweep: give up on what has expired, then
   * send what is due (waiting or failed, attempts left, no hold, backoff or
   * lease ahead), oldest first, `PUSH_SWEEP_BATCH` at a time, until
   * `PUSH_SWEEP_BUDGET_MS` has passed.
   *
   * `now` is the moment rows are judged at; the deadline is the real
   * clock's, as TAY's sweep has it.
   */
  async sweep(now: Date): Promise<PushQueueSweepResult> {
    const deadline = Date.now() + PUSH_SWEEP_BUDGET_MS;
    const result: PushQueueSweepResult = {
      sent: 0,
      failed: 0,
      dropped: 0,
      expired: 0,
      waiting: 0,
      held: 0,
    };

    const expired = await this.prisma.pushMessage.updateMany({
      where: { status: { in: OPEN_STATUSES }, expiresAt: { lte: now } },
      data: {
        status: PushMessageStatus.DROPPED,
        dropReason: PushDropReason.EXPIRED,
        retryAfter: null,
      },
    });
    result.expired = expired.count;

    const due = await this.prisma.pushMessage.findMany({
      where: {
        status: { in: OPEN_STATUSES },
        attempts: { lt: PUSH_MAX_ATTEMPTS },
        expiresAt: { gt: now },
        OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: PUSH_SWEEP_BATCH,
      select: { id: true },
    });

    const outcomes = await this.dispatchAll(
      due.map(({ id }) => id),
      deadline,
      now,
    );

    for (const outcome of outcomes) {
      if (outcome === 'sent') result.sent += 1;
      else if (outcome === 'failed') result.failed += 1;
      else if (outcome === 'dropped') result.dropped += 1;
      else if (outcome === 'expired') result.expired += 1;
      else if (outcome === 'waiting') result.waiting += 1;
    }

    // Never tried, released later: a claim's lease and a backoff both
    // follow an attempt, so only the off-hours hold matches (D6).
    result.held = await this.prisma.pushMessage.count({
      where: {
        status: PushMessageStatus.PENDING,
        attempts: 0,
        retryAfter: { gt: now },
      },
    });

    return result;
  }

  /**
   * Send one push: claim it, check its recipient again (D11), send to every
   * device they hold, forget the dead ones, and settle the row. Only the
   * claim's winner sends and writes the outcome.
   *
   * `deadline` (epoch milliseconds) bounds every send's timeout, and must
   * fall inside the lease, so no send outlives it.
   */
  async dispatchOne(
    id: string,
    deadline: number,
    now: Date = new Date(),
  ): Promise<DispatchOutcome> {
    if (deadline - Date.now() >= PUSH_LEASE_MS) {
      throw new Error('A push dispatch deadline must fall inside its lease.');
    }

    const row = await this.prisma.pushMessage.findUnique({
      where: { id },
      select: DISPATCH_SELECT,
    });

    if (
      row === null ||
      !OPEN_STATUSES.some((status) => status === row.status) ||
      row.attempts >= PUSH_MAX_ATTEMPTS ||
      (row.retryAfter !== null && row.retryAfter > now)
    ) {
      return 'skipped';
    }

    if (row.expiresAt <= now) {
      await this.drop(row.id, null, PushDropReason.EXPIRED);
      return 'expired';
    }

    // No claim, no attempt: the push waits until the service has keys.
    if (!this.sender.isConfigured) return 'waiting';

    // The claim, as a lease: only the caller whose increment lands sends,
    // and `retryAfter` moves past the longest send, so no sweep picks the
    // row up while it is in flight.
    const attempts = row.attempts + 1;
    const claimed = await this.prisma.pushMessage.updateMany({
      where: {
        id: row.id,
        attempts: row.attempts,
        status: { in: OPEN_STATUSES },
        OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
      },
      data: {
        attempts: { increment: 1 },
        retryAfter: new Date(now.getTime() + PUSH_LEASE_MS),
      },
    });

    if (claimed.count !== 1) return 'skipped';

    if (!(await this.recipientStillReceives(row))) {
      await this.drop(row.id, attempts, PushDropReason.RECIPIENT_GONE);
      return 'dropped';
    }

    const devices =
      row.customerId !== null
        ? await this.prisma.customerPushSubscription.findMany({
            where: { customerId: row.customerId },
            select: { id: true, endpoint: true, p256dh: true, auth: true },
          })
        : await this.prisma.staffPushSubscription.findMany({
            where: { staffId: row.staffId ?? '' },
            select: { id: true, endpoint: true, p256dh: true, auth: true },
          });

    if (devices.length === 0) {
      await this.drop(row.id, attempts, PushDropReason.NO_DEVICE);
      return 'dropped';
    }

    const ttlSeconds = Math.min(
      Math.max(
        Math.floor((row.expiresAt.getTime() - now.getTime()) / 1000),
        MIN_PUSH_TTL_S,
      ),
      MAX_PUSH_TTL_S,
    );
    const outcomes: { id: string; outcome: PushOutcome }[] = await Promise.all(
      devices.map(async (device) => ({
        id: device.id,
        outcome: await this.sender
          .send(
            device,
            {
              id: row.id,
              title: row.title,
              body: row.body,
              link: row.link,
              ref: row.ref,
              tag: row.tag,
              urgent: row.urgent,
              renotify: row.renotify,
            },
            {
              ttlSeconds,
              urgency: row.urgent ? 'high' : 'normal',
              timeoutMs: Math.max(1_000, deadline - Date.now()),
            },
          )
          .catch((): PushOutcome => 'RETRY'),
      })),
    );

    if (outcomes.every(({ outcome }) => outcome === 'SKIPPED')) {
      // The sender turned out unconfigured: give the attempt back.
      await this.prisma.pushMessage.updateMany({
        where: { id: row.id, attempts },
        data: { attempts: row.attempts, retryAfter: null },
      });
      return 'waiting';
    }

    const dead = outcomes
      .filter(({ outcome }) => outcome === 'GONE' || outcome === 'KEY_MISMATCH')
      .map(({ id: deviceId }) => deviceId);
    const sent = outcomes
      .filter(({ outcome }) => outcome === 'SENT')
      .map(({ id: deviceId }) => deviceId);

    if (dead.length > 0) {
      if (row.customerId !== null) {
        await this.prisma.customerPushSubscription.deleteMany({
          where: { id: { in: dead } },
        });
      } else {
        await this.prisma.staffPushSubscription.deleteMany({
          where: { id: { in: dead } },
        });
      }
    }

    if (sent.length > 0) {
      if (row.customerId !== null) {
        await this.prisma.customerPushSubscription.updateMany({
          where: { id: { in: sent } },
          data: { lastSuccessAt: now },
        });
      } else {
        await this.prisma.staffPushSubscription.updateMany({
          where: { id: { in: sent } },
          data: { lastSuccessAt: now },
        });
      }
    }

    const summary =
      `Push ${row.id} (${row.event}, attempt ${attempts}): ` +
      `${outcomes.map(({ outcome }) => outcome).join(', ')}` +
      (dead.length > 0 ? `; ${dead.length} device(s) forgotten` : '');

    if (sent.length > 0) {
      // A delivery is a fact whichever claim made it.
      await this.prisma.pushMessage.updateMany({
        where: { id: row.id, status: { not: PushMessageStatus.SENT } },
        data: {
          status: PushMessageStatus.SENT,
          sentAt: now,
          retryAfter: null,
          dropReason: null,
        },
      });
      this.logger.log(`${summary}. SENT.`);
      return 'sent';
    }

    if (
      outcomes.some(
        ({ outcome }) => outcome === 'RETRY' || outcome === 'SKIPPED',
      )
    ) {
      if (attempts >= PUSH_MAX_ATTEMPTS) {
        await this.drop(row.id, attempts, PushDropReason.GAVE_UP);
        this.logger.warn(`${summary}. DROPPED (GAVE_UP).`);
        return 'dropped';
      }

      await this.prisma.pushMessage.updateMany({
        where: { id: row.id, attempts, status: { in: OPEN_STATUSES } },
        data: {
          status: PushMessageStatus.FAILED,
          retryAfter: pushRetryAfter(attempts, now),
        },
      });
      this.logger.warn(`${summary}. FAILED.`);
      return 'failed';
    }

    const reason =
      dead.length === outcomes.length
        ? PushDropReason.NO_DEVICE
        : PushDropReason.REJECTED;

    await this.drop(row.id, attempts, reason);
    this.logger.warn(`${summary}. DROPPED (${reason}).`);
    return 'dropped';
  }

  /**
   * Whether the row's recipient may still receive it (D11): a customer not
   * deleted; a staff member still active, whose role is still in the
   * event's audience and still opens its page. The guard re-reads `Staff`
   * on every request (A14); a push re-reads it before every send.
   */
  private async recipientStillReceives(row: DispatchRow): Promise<boolean> {
    if (row.customerId !== null) {
      const customer = await this.prisma.customer.findUnique({
        where: { id: row.customerId },
        select: { deletedAt: true },
      });

      return customer !== null && customer.deletedAt === null;
    }

    if (row.staffId === null || !isPushEvent(row.event)) return false;

    const entry = PUSH_CATALOGUE[row.event];

    if (entry.realm !== 'STAFF') return false;

    const staff = await this.prisma.staff.findUnique({
      where: { id: row.staffId },
      select: { isActive: true, role: true },
    });

    return (
      staff !== null &&
      staff.isActive &&
      roleReceives(row.event as StaffPushEvent, staff.role)
    );
  }

  /**
   * Give a push up. `attempts` names the claim that decided it, so a late
   * answer never overwrites a later claim's; null when no claim was made.
   * A sent push is never dropped.
   */
  private async drop(
    id: string,
    attempts: number | null,
    reason: PushDropReason,
  ): Promise<void> {
    await this.prisma.pushMessage.updateMany({
      where: {
        id,
        status: { in: OPEN_STATUSES },
        ...(attempts === null ? {} : { attempts }),
      },
      data: {
        status: PushMessageStatus.DROPPED,
        dropReason: reason,
        retryAfter: null,
      },
    });
  }

  /**
   * `ids` dispatched `DELIVERY_CONCURRENCY` at a time, starting nothing
   * after `deadline`. One push's failure is that push's, never the batch's.
   */
  private async dispatchAll(
    ids: string[],
    deadline: number,
    now: Date,
  ): Promise<DispatchOutcome[]> {
    const outcomes: DispatchOutcome[] = [];

    for (let start = 0; start < ids.length; start += DELIVERY_CONCURRENCY) {
      if (Date.now() >= deadline) break;

      outcomes.push(
        ...(await Promise.all(
          ids.slice(start, start + DELIVERY_CONCURRENCY).map((id) =>
            this.dispatchOne(id, deadline, now).catch(
              (error: unknown): DispatchOutcome => {
                this.logger.error(
                  `Push ${id} could not be dispatched: ` +
                    `${error instanceof Error ? error.name : 'unknown error'}.`,
                );
                return 'skipped';
              },
            ),
          ),
        )),
      );
    }

    return outcomes;
  }

  /**
   * The pure part of a write (D1): the push rendered and its expiry from
   * `now`, or null (logged) when the entry cannot render this input, or its
   * topic or key would not fit their columns. `owners` are the ids the key
   * will carry (for staff, the longest an id can be).
   */
  private prepare(
    event: PushEvent,
    input: PushInput<PushInputs[PushEvent]>,
    now: Date,
    realm: 'c' | 's',
    owners: string[],
  ): {
    push: RenderedPush;
    expiresAt: Date;
    built: PushInputs[PushEvent];
  } | null {
    try {
      const built = typeof input === 'function' ? input() : input;
      const push = renderPush(event, built);
      const expiresAt = pushExpiresAt(event, built, now);

      if (
        push.about.length > TOPIC_MAX ||
        owners.some(
          (owner) =>
            dedupeKeyOf(event, push.about, realm, owner).length >
            DEDUPE_KEY_MAX,
        )
      ) {
        throw new Error('The topic or key is over its column.');
      }

      return { push, expiresAt, built };
    } catch (error) {
      this.notQueued(event, error);
      return null;
    }
  }

  /** The row's columns every owner shares. */
  private columns(event: string, push: RenderedPush) {
    return {
      event,
      topic: push.about,
      title: push.title,
      body: push.body,
      link: push.link,
      ref: push.ref,
      tag: push.tag,
      urgent: push.urgent,
      renotify: push.renotify,
    };
  }

  private notQueued(event: string, error: unknown): void {
    this.logger.error(
      `Push ${event} not queued: ` +
        `${error instanceof Error ? error.name : 'unknown error'}.`,
    );
  }
}

/** `<event>:<about>:<c|s>:<ownerId>`: one row per person per event. */
function dedupeKeyOf(
  event: string,
  about: string,
  realm: 'c' | 's',
  ownerId: string,
): string {
  return `${event}:${about}:${realm}:${ownerId}`;
}
