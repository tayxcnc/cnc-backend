import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import {
  type InitializeTransaction,
  type InitializedTransaction,
  PAYSTACK_CLIENT,
  PAYSTACK_CURRENCY,
  type PaystackClient,
  PaystackRefusedError,
  PaystackUnavailableError,
  type QueuedRefund,
  type RefundTransaction,
  type VerifiedTransaction,
} from '../src/payments/paystack-client';

/**
 * A Paystack client that calls nobody and remembers everything (TAY's
 * `FakePaystackService`, for CNC's interface). Installed by `createTestApp`
 * in every e2e app: no suite may open a transaction on CNC's merchant
 * account or depend on Paystack's network.
 *
 * `initialize` records what would have been sent, above all the amount,
 * because "kobo, never multiplied" is only shown by the integer that
 * reaches this boundary. `verify` answers a recorded transaction the test
 * has `pay`-ed as paid by a test Visa ending 4081 for the amount
 * initialized, one not paid as `abandoned`, and refuses (400) a reference
 * never initialized, as Paystack does, unless a test has set
 * `verifyAnswers` for the reference (a wrong amount, a failed status).
 * `failNextInitializeWith` makes the next initialize reject once.
 */
export class FakePaystackClient implements PaystackClient {
  readonly initialized: InitializeTransaction[] = [];
  readonly verified: string[] = [];
  readonly verifyAnswers = new Map<string, Partial<VerifiedTransaction>>();
  failNextInitializeWith: Error | null = null;
  /**
   * The next initialize opens the transaction at Paystack and then loses
   * its answer (a timeout after Paystack acted), once.
   */
  loseNextInitializeAnswer = false;
  failNextVerifyWith: Error | null = null;
  failNextRefundWith: Error | null = null;
  /** Every refund Paystack accepted, in order. */
  readonly refunds: RefundTransaction[] = [];
  /** References the customer has paid on Paystack's page (`pay`). */
  readonly paid = new Set<string>();

  /**
   * The customer pays on Paystack's page: from now on verify answers the
   * transaction `success`. Until then an initialized transaction verifies
   * as `abandoned`, as Paystack's does, so a recheck finds it unpaid.
   */
  pay(reference: string): void {
    this.paid.add(reference);
  }

  initialize(input: InitializeTransaction): Promise<InitializedTransaction> {
    if (this.failNextInitializeWith !== null) {
      const error = this.failNextInitializeWith;

      this.failNextInitializeWith = null;

      return Promise.reject(error);
    }

    if (this.initialized.some((one) => one.reference === input.reference)) {
      // Paystack refuses a reference it has seen.
      return Promise.reject(
        new PaystackRefusedError(400, 'Duplicate Transaction Reference'),
      );
    }

    this.initialized.push(input);

    if (this.loseNextInitializeAnswer) {
      // Paystack opened the transaction; its answer never arrived.
      this.loseNextInitializeAnswer = false;

      return Promise.reject(new PaystackUnavailableError());
    }

    return Promise.resolve({
      authorizationUrl: `https://checkout.paystack.test/${input.reference}`,
      accessCode: `access-${input.reference}`,
    });
  }

  /**
   * A refund as Paystack's test mode takes one: recorded, queued with an
   * id, and refused (as Paystack refuses) when it names a transaction that
   * was never paid or would take back more than was paid.
   * `failNextRefundWith` makes the next refund reject once instead.
   */
  refund(input: RefundTransaction): Promise<QueuedRefund> {
    if (this.failNextRefundWith !== null) {
      const error = this.failNextRefundWith;

      this.failNextRefundWith = null;

      return Promise.reject(error);
    }

    const sent = this.initialized.find(
      (one) => one.reference === input.transactionReference,
    );

    if (sent === undefined || !this.paid.has(input.transactionReference)) {
      return Promise.reject(
        new PaystackRefusedError(400, 'Transaction not found'),
      );
    }

    const refundedKobo = this.refunds
      .filter((one) => one.transactionReference === input.transactionReference)
      .reduce((sum, one) => sum + one.amountKobo, 0);

    if (refundedKobo + input.amountKobo > sent.amountKobo) {
      return Promise.reject(
        new PaystackRefusedError(
          400,
          'Refund amount cannot be more than the unrefunded balance',
        ),
      );
    }

    this.refunds.push(input);

    return Promise.resolve({
      refundId: String(1000 + this.refunds.length),
      status: 'pending',
    });
  }

  verify(reference: string): Promise<VerifiedTransaction> {
    this.verified.push(reference);

    if (this.failNextVerifyWith !== null) {
      const error = this.failNextVerifyWith;

      this.failNextVerifyWith = null;

      return Promise.reject(error);
    }

    const sent = this.initialized.find((one) => one.reference === reference);

    if (sent === undefined && !this.verifyAnswers.has(reference)) {
      // Paystack's answer for a reference it never initialized.
      return Promise.reject(
        new PaystackRefusedError(400, 'Transaction reference not found'),
      );
    }

    const base: VerifiedTransaction =
      sent === undefined
        ? {
            status: 'abandoned',
            reference,
            amountKobo: undefined,
            currency: undefined,
            paidAt: undefined,
            card: undefined,
          }
        : !this.paid.has(reference)
          ? {
              // Opened and not paid: what Paystack answers while the
              // customer is still on its page, or left it.
              status: 'abandoned',
              reference,
              amountKobo: sent.amountKobo,
              currency: PAYSTACK_CURRENCY,
              paidAt: undefined,
              card: undefined,
            }
          : {
              status: 'success',
              reference,
              amountKobo: sent.amountKobo,
              currency: PAYSTACK_CURRENCY,
              paidAt: new Date(),
              card: { type: 'visa ', last4: '4081' },
            };

    return Promise.resolve({ ...base, ...this.verifyAnswers.get(reference) });
  }
}

/** The fake Paystack client of an app `createTestApp` built. */
export function fakePaystack(app: INestApplication<App>): FakePaystackClient {
  return app.get<FakePaystackClient>(PAYSTACK_CLIENT, { strict: false });
}
