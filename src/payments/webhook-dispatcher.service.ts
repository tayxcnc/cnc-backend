import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CheckoutPaymentsService } from './checkout-payments.service';
import { PaymentEventService } from './payment-event.service';
import {
  CHARGE_SUCCESS,
  type PaystackEnvelope,
  referenceOf,
} from './paystack-events';
import { readTransaction } from './paystack-transaction';

/**
 * Hands a verified, recorded delivery to what acts on it, after the
 * webhook has answered (TAY's `WebhookDispatcherService`, plan §8.2).
 *
 * After the answer, because Paystack retries a slow delivery: work done
 * inside the request (verify is a network call) would turn a slow minute
 * into a retry of an event already being handled. Every dispatch is
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

  /** Start handling a delivery without waiting for it. */
  dispatchInBackground(
    envelope: PaystackEnvelope,
    paymentEventId: string,
  ): void {
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
   * entry for an unprocessed event (C7-5), which has the reference only.
   */
  async dispatch(
    envelope: PaystackEnvelope,
    paymentEventId: string,
  ): Promise<void> {
    if (envelope.event === CHARGE_SUCCESS) {
      const reference = referenceOf(envelope.data);

      if (reference === undefined) {
        this.logger.warn('A charge.success delivery carried no reference.');
      } else {
        await this.checkouts.confirm(reference, readTransaction(envelope.data));
      }
    } else {
      this.logger.log(`Ignoring unhandled event ${envelope.event}.`);
    }

    await this.events.markProcessed(paymentEventId);
  }
}
