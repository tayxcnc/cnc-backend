import { Injectable, Logger } from '@nestjs/common';
import { CheckoutStatus } from '../../generated/cnc-client';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { PushQueueService, type PushTopics } from '../push/push-queue.service';
import {
  CheckoutPaymentsService,
  type ConfirmOutcome,
} from './checkout-payments.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/** The most rows one run of either sweep handles: each costs a verify. */
export const PAYMENT_SWEEP_BATCH = 50;

/**
 * How old an unprocessed webhook delivery must be before the payments
 * sweep handles it again (plan §5.5): five minutes, so a delivery still
 * being handled after its answer is left to finish.
 */
export const UNPROCESSED_EVENT_AGE_MS = 5 * 60 * 1000;

/** What one run of the checkouts sweep did. */
export interface CheckoutsSweepResult {
  /** Overdue checkouts asked about this run. */
  checked: number;
  /** Of those, paid after all (a webhook that never came): orders written. */
  paid: number;
  /** Of those, paid wrongly: held `NEEDS_ATTENTION`. */
  held: number;
  /** Of those, never paid: `EXPIRED`. */
  expired: number;
  /** Of those, left `PENDING` because Paystack could not be reached. */
  unreachable: number;
}

/** What one run of the payments sweep did. */
export interface PaymentsSweepResult {
  /** Unprocessed deliveries handled again and marked processed. */
  redispatched: number;
  /** Deliveries left unprocessed because handling them failed again. */
  failed: number;
}

/**
 * The two payment sweeps (plan §5.5; card C7-5), behind
 * `POST /internal/sweeps/checkouts` and `/payments`.
 *
 * Both are backstops, not mechanisms (*Infrastructure*): a payment is
 * settled by the webhook or by the confirmation read, whichever comes
 * first, and neither depends on a sweep. Both are idempotent by the same
 * conditional updates the webhook relies on, so two runs at once, or a run
 * racing a webhook, settle a checkout once.
 *
 * The staff pushes a run's settles queue (C10: a paid order, its docket, a
 * held checkout) are collected and sent once, at the end of the run, under
 * one deadline (D14), so a run's length never grows with a push service's.
 */
@Injectable()
export class PaymentSweepsService {
  private readonly logger = new Logger(PaymentSweepsService.name);

  constructor(
    private readonly prisma: CncPrismaService,
    private readonly payments: CheckoutPaymentsService,
    private readonly dispatcher: WebhookDispatcherService,
    private readonly push: PushQueueService,
  ) {}

  /**
   * Every `PENDING` checkout past its `expiresAt`, oldest first, is asked
   * about with Paystack's verify (`recheck`). Paid: the order is written
   * now (a late or lost webhook). Paid wrongly: held. Not paid: `EXPIRED`,
   * by one conditional update on `PENDING`, so a payment landing in the
   * meantime wins and an expired checkout drew no number. Paystack
   * unreachable leaves it `PENDING` for the next run; a late payment on an
   * expired checkout is still settled by the webhook.
   */
  async sweepCheckouts(now: Date): Promise<CheckoutsSweepResult> {
    const overdue = await this.prisma.checkout.findMany({
      where: { status: CheckoutStatus.PENDING, expiresAt: { lt: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: PAYMENT_SWEEP_BATCH,
      select: { id: true, reference: true },
    });
    const result: CheckoutsSweepResult = {
      checked: overdue.length,
      paid: 0,
      held: 0,
      expired: 0,
      unreachable: 0,
    };
    const pushes: PushTopics = [];

    for (const checkout of overdue) {
      let outcome: ConfirmOutcome;

      try {
        outcome = await this.payments.recheck(checkout.reference, pushes);
      } catch (error) {
        result.unreachable += 1;
        this.logger.warn(
          `Checkout ${checkout.id} could not be rechecked: ` +
            `${error instanceof Error ? error.name : 'unknown'}.`,
        );
        continue;
      }

      if (outcome === 'paid') result.paid += 1;
      else if (outcome === 'needs-attention') result.held += 1;
      else if (outcome === 'unpaid') {
        const { count } = await this.prisma.checkout.updateMany({
          where: { id: checkout.id, status: CheckoutStatus.PENDING },
          data: { status: CheckoutStatus.EXPIRED },
        });

        result.expired += count;
      }
    }

    await this.push.dispatchTopics(pushes);

    return result;
  }

  /**
   * Every webhook delivery recorded and not processed for five minutes,
   * oldest first, is handled again through the dispatcher and marked
   * processed (plan §5.5: the gap TAY has). The body is not stored (a
   * charge carries the card authorization), so a `charge.success` is
   * handled by its reference alone: verify decides, as it always does, and
   * a reported payment verify does not confirm is held. A failure (verify
   * unreachable) leaves the row for the next run.
   */
  async sweepPayments(now: Date): Promise<PaymentsSweepResult> {
    const stale = await this.prisma.paymentEvent.findMany({
      where: {
        processedAt: null,
        createdAt: { lt: new Date(now.getTime() - UNPROCESSED_EVENT_AGE_MS) },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PAYMENT_SWEEP_BATCH,
      select: { id: true, event: true, reference: true },
    });
    const result: PaymentsSweepResult = { redispatched: 0, failed: 0 };
    const pushes: PushTopics = [];

    for (const row of stale) {
      try {
        await this.dispatcher.dispatch(
          {
            event: row.event,
            data: row.reference === null ? {} : { reference: row.reference },
          },
          row.id,
          pushes,
        );
        result.redispatched += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.warn(
          `Payment event ${row.id} failed again: ` +
            `${error instanceof Error ? error.name : 'unknown'}.`,
        );
      }
    }

    await this.push.dispatchTopics(pushes);

    return result;
  }
}
