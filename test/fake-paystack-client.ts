import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import {
  type InitializeTransaction,
  type InitializedTransaction,
  PAYSTACK_CLIENT,
  PAYSTACK_CURRENCY,
  type PaystackClient,
  PaystackRefusedError,
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
 * reaches this boundary. `verify` answers a recorded transaction as paid
 * by a test Visa ending 4081 for the amount initialized, unless a test has
 * set `verifyAnswers` for the reference (a wrong amount, a failed status).
 * `failNextInitializeWith` makes the next initialize reject once.
 */
export class FakePaystackClient implements PaystackClient {
  readonly initialized: InitializeTransaction[] = [];
  readonly verified: string[] = [];
  readonly verifyAnswers = new Map<string, Partial<VerifiedTransaction>>();
  failNextInitializeWith: Error | null = null;
  failNextVerifyWith: Error | null = null;

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

    return Promise.resolve({
      authorizationUrl: `https://checkout.paystack.test/${input.reference}`,
      accessCode: `access-${input.reference}`,
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
