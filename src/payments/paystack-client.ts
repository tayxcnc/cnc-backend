/**
 * What CNC asks of Paystack (plan §8, C7): start a transaction and ask what
 * happened to one. An interface, bound by `PAYSTACK_CLIENT`, so the
 * service talks to Paystack over HTTP (`HttpPaystackClient`), a local run
 * talks to nobody (`LocalPaystackClient`), and every e2e app gets a fake
 * that records what it was asked (`test/fake-paystack-client.ts`). No test
 * and no local walk may reach Paystack.
 *
 * CNC's own merchant account only (`CNC_PAYSTACK_SECRET_KEY`); TAY's keys
 * and code are never used (A3, A4).
 */

/** The injection token of the Paystack client. */
export const PAYSTACK_CLIENT = Symbol('PAYSTACK_CLIENT');

/** The currency every CNC charge is in. */
export const PAYSTACK_CURRENCY = 'NGN';

/** What `initialize` sends. Amounts are kobo, never multiplied by 100. */
export interface InitializeTransaction {
  email: string;
  amountKobo: number;
  /** Chosen by CNC (`cnc-order-<uuid>`), so a webhook finds its checkout. */
  reference: string;
  /** Where Paystack sends the browser back; Paystack's default when absent. */
  callbackUrl?: string;
  /** Read by a person in Paystack's dashboard; never matched on. */
  metadata?: Record<string, string>;
}

/** What Paystack answered to `initialize`. */
export interface InitializedTransaction {
  authorizationUrl: string;
  accessCode: string;
}

/** The card that paid, as far as a receipt may name it (plan §8.5). */
export interface PaidCard {
  /** Paystack's `card_type`, trimmed: `visa`, `mastercard DEBIT`. */
  type: string;
  last4: string;
}

/**
 * What Paystack's verify said about a transaction, narrowed at runtime:
 * every field Paystack did not send in the expected shape is absent, never
 * guessed.
 */
export interface VerifiedTransaction {
  /** `success`, `failed`, `abandoned`, `ongoing`… as Paystack words it. */
  status: string;
  reference: string | undefined;
  amountKobo: number | undefined;
  currency: string | undefined;
  paidAt: Date | undefined;
  card: PaidCard | undefined;
}

/**
 * Paystack could not be reached, or did not answer in time. Whether the
 * call took effect is unknown; verify is the only way to find out.
 */
export class PaystackUnavailableError extends Error {
  constructor() {
    super('The payment provider could not be reached.');
    this.name = 'PaystackUnavailableError';
  }
}

/**
 * Paystack answered and refused (its `status: false`, or a non-2xx).
 * `providerStatus` is its HTTP status; `providerMessage` its own words,
 * for a log line, never for a customer.
 */
export class PaystackRefusedError extends Error {
  constructor(
    readonly providerStatus: number,
    readonly providerMessage: string,
  ) {
    super(`Paystack refused the request (${providerStatus}).`);
    this.name = 'PaystackRefusedError';
  }
}

/**
 * What `refund` sends (C7-4, Q26): money back to the card of one paid
 * transaction. Kobo, never multiplied. CNC absorbs Paystack's fee (Q26):
 * the customer gets `amountKobo` back and nothing is taken off it.
 */
export interface RefundTransaction {
  /** The paid transaction's reference: the checkout's `cnc-order-<uuid>`. */
  transactionReference: string;
  amountKobo: number;
  /** Read by a person in Paystack's dashboard; never matched on. */
  merchantNote?: string;
}

/** What Paystack answered to `refund`: it has queued the refund. */
export interface QueuedRefund {
  /** Paystack's refund id, as text. */
  refundId: string;
  /** Paystack's word for the refund now: `pending`, `processing`, `processed`. */
  status: string;
}

/**
 * The calls CNC makes. None is retried by the client (TAY's rule): a
 * retried refund after a timeout could send the money twice.
 */
export interface PaystackClient {
  initialize(input: InitializeTransaction): Promise<InitializedTransaction>;
  verify(reference: string): Promise<VerifiedTransaction>;
  /**
   * Ask Paystack to refund part or all of a paid transaction. Throws
   * `PaystackRefusedError` when Paystack answered no (nothing was
   * refunded) and `PaystackUnavailableError` when the answer did not
   * arrive or could not be read (the refund may or may not exist).
   */
  refund(input: RefundTransaction): Promise<QueuedRefund>;
}
