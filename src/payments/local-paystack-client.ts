import { Logger } from '@nestjs/common';
import {
  type InitializeTransaction,
  type InitializedTransaction,
  PAYSTACK_CURRENCY,
  type PaystackClient,
  type QueuedRefund,
  type RefundTransaction,
  type VerifiedTransaction,
} from './paystack-client';

/**
 * The Paystack client of a local run (`CNC_ENV=local`): it calls nobody,
 * as the local mail transport sends nothing (*Mail and the outbound
 * queue*). No local run can take money or open a transaction on CNC's
 * merchant account, whatever key `.env` holds.
 *
 * `initialize` remembers the amount and answers a page that does not exist;
 * `verify` answers a transaction it initialized as paid by a test Visa
 * ending 4081, with that amount, so a local walk completes a checkout by
 * signing a fake `charge.success` with the local key. A reference it never
 * initialized is `abandoned`. Memory only: a restart forgets.
 */
export class LocalPaystackClient implements PaystackClient {
  private readonly logger = new Logger(LocalPaystackClient.name);
  private readonly amounts = new Map<string, number>();
  private refunds = 0;

  initialize(input: InitializeTransaction): Promise<InitializedTransaction> {
    this.amounts.set(input.reference, input.amountKobo);
    this.logger.log(
      `Local run: no Paystack call. Checkout ${input.reference} would be ` +
        `charged ${input.amountKobo} kobo.`,
    );

    return Promise.resolve({
      authorizationUrl: `https://checkout.paystack.invalid/${input.reference}`,
      accessCode: `local-${input.reference}`,
    });
  }

  /**
   * Remembers nothing and calls nobody: a local walk's refund is accepted
   * with a made-up id, so the Online Orders screen can be walked end to end.
   */
  refund(input: RefundTransaction): Promise<QueuedRefund> {
    this.refunds += 1;
    this.logger.log(
      `Local run: no Paystack call. ${input.amountKobo} kobo of ` +
        `${input.transactionReference} would be refunded.`,
    );

    return Promise.resolve({
      refundId: `local-refund-${this.refunds}`,
      status: 'pending',
    });
  }

  verify(reference: string): Promise<VerifiedTransaction> {
    const amountKobo = this.amounts.get(reference);

    return Promise.resolve(
      amountKobo === undefined
        ? {
            status: 'abandoned',
            reference,
            amountKobo: undefined,
            currency: undefined,
            paidAt: undefined,
            card: undefined,
          }
        : {
            status: 'success',
            reference,
            amountKobo,
            currency: PAYSTACK_CURRENCY,
            paidAt: new Date(),
            card: { type: 'visa', last4: '4081' },
          },
    );
  }
}
