import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { PushTopics } from '../push/push-queue.service';
import { CheckoutPaymentsService } from './checkout-payments.service';
import { PaymentEventService } from './payment-event.service';
import {
  CHARGE_SUCCESS,
  type PaystackEnvelope,
  referenceOf,
} from './paystack-events';
import { readTransaction } from './paystack-transaction';

/**
 * Hands a verified, recorded delivery to what acts on it (TAY's
 * `WebhookDispatcherService`, plan §8.2), while the webhook's request
 * waits a few seconds for it (`dispatchWithin`), and after the answer if
 * it takes longer.
 *
 * Never unbounded inside the request, because Paystack retries a slow
 * delivery: a slow minute of verify would turn into a retry of an event
 * already being handled. Not entirely after it either, because Cloud Run
 * throttles CPU outside requests. Every dispatch is
 * wrapped so a failure is logged, never an unhandled rejection, and the
 * in-flight set is drained on shutdown, so a Cloud Run SIGTERM mid-deploy
 * does not abandon a payment half handled. A failure leaves the
 * `PaymentEvent` unprocessed, for the payments sweep (C7-5).
 *
 * CNC acts on `charge.success` only. Every other event is acknowledged
 * and marked processed, because answering anything else would make
 * Paystack retry an event that will never be handled.
 */
@Injectable()
export class WebhookDispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly events: PaymentEventService,
    private readonly checkouts: CheckoutPaymentsService,
  ) {}

  /**
   * Handle a delivery, waiting for it at most `waitMs` before answering;
   * past that it carries on in the background. Cloud Run gives an
   * instance CPU only while a request is open (request-based allocation,
   * the default, with `--min-instances 0`), so work left entirely to the
   * background may stall until the next request; a verify and a settle
   * normally finish within a second, inside the delivery's own request.
   * The cap keeps a slow Paystack from turning the delivery into a retry.
   */
  async dispatchWithin(
    envelope: PaystackEnvelope,
    paymentEventId: string,
    waitMs: number,
  ): Promise<void> {
    const work = this.dispatchInBackground(envelope, paymentEventId);
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });

    try {
      await Promise.race([work, cap]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Start handling a delivery without waiting for it. Answers the work,
   * which never rejects.
   */
  dispatchInBackground(
    envelope: PaystackEnvelope,
    paymentEventId: string,
  ): Promise<void> {
    const work = this.dispatch(envelope, paymentEventId).catch(
      (error: unknown) => {
        // The event id, never the payload: a charge's body carries the
        // card authorization.
        this.logger.error(
          `Handling ${envelope.event} failed; the delivery is recorded and ` +
            `unprocessed (payment event ${paymentEventId}).`,
          error instanceof Error ? error.stack : undefined,
        );
      },
    );

    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));

    return work;
  }

  /** Every dispatch running now, settled. For shutdown and the e2e suite. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.settled();
  }

  /**
   * Handle one delivery and mark it processed. Also the payments sweep's
   * entry for an unprocessed event (C7-5), which has the reference only,
   * and passes `pushes` to send its run's pushes once at the end (C10).
   */
  async dispatch(
    envelope: PaystackEnvelope,
    paymentEventId: string,
    pushes?: PushTopics,
  ): Promise<void> {
    if (envelope.event === CHARGE_SUCCESS) {
      const reference = referenceOf(envelope.data);

      if (reference === undefined) {
        this.logger.warn('A charge.success delivery carried no reference.');
      } else {
        await this.checkouts.confirm(
          reference,
          readTransaction(envelope.data),
          pushes,
        );
      }
    } else {
      this.logger.log(`Ignoring unhandled event ${envelope.event}.`);
    }

    await this.events.markProcessed(paymentEventId);
  }
}
