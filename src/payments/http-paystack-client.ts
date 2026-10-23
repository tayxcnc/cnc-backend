import { Logger } from '@nestjs/common';
import {
  type InitializeTransaction,
  type InitializedTransaction,
  type PaystackClient,
  PaystackRefusedError,
  PaystackUnavailableError,
  type VerifiedTransaction,
} from './paystack-client';
import { asRecord, stringAt } from './payload-readers';
import { readTransaction } from './paystack-transaction';

/** Paystack's API root. */
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

/**
 * How long one call may take (TAY's ten seconds): a Paystack incident must
 * degrade a checkout into an error, not hang the instance.
 */
export const PAYSTACK_TIMEOUT_MS = 10_000;

/**
 * Paystack over HTTP, copied from TAY's `PaystackService` (plan §8.2):
 * plain `fetch`, a 10-second timeout, **no retries** (a retry after a
 * timeout cannot tell "never arrived" from "succeeded and the answer was
 * lost"; verify answers that), kobo passed through unmultiplied, and
 * **never a body in a log line** (a success carries the card
 * authorization). Unlike TAY's, every answer is narrowed at runtime rather
 * than cast: the shape Paystack sends is checked before anything reads it.
 *
 * Bound only on staging and production (`paystackClientFor`); a local run
 * and every test use a client that calls nobody.
 */
export class HttpPaystackClient implements PaystackClient {
  private readonly logger = new Logger(HttpPaystackClient.name);

  constructor(private readonly secretKey: () => string | undefined) {}

  async initialize(
    input: InitializeTransaction,
  ): Promise<InitializedTransaction> {
    const data = asRecord(
      await this.request('POST', '/transaction/initialize', {
        email: input.email,
        // Already kobo. Multiplying here charges a hundred times the price.
        amount: input.amountKobo,
        currency: 'NGN',
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      }),
    );
    const authorizationUrl = data && stringAt(data, 'authorization_url');
    const accessCode = data && stringAt(data, 'access_code');

    if (authorizationUrl === undefined || accessCode === undefined) {
      this.logger.error(
        'Paystack initialize answered without an authorization URL or access code.',
      );
      throw new PaystackRefusedError(502, 'Malformed initialize answer.');
    }

    return { authorizationUrl, accessCode };
  }

  async verify(reference: string): Promise<VerifiedTransaction> {
    const transaction = readTransaction(
      await this.request(
        'GET',
        `/transaction/verify/${encodeURIComponent(reference)}`,
      ),
    );

    if (transaction === undefined) {
      this.logger.error('Paystack verify answered without a status.');
      throw new PaystackRefusedError(502, 'Malformed verify answer.');
    }

    return transaction;
  }

  /**
   * One call with the timeout, the key and the error policy. Answers
   * `data`, unread; throws `PaystackUnavailableError` when Paystack was not
   * reached and `PaystackRefusedError` when it answered and refused. Logs
   * the method, path and status, never a body.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const key = this.secretKey();

    if (key === undefined) throw new PaystackUnavailableError();

    let response: Response;

    try {
      response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(PAYSTACK_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(
        `Paystack ${method} ${pathForLog(path)} did not complete: ${
          error instanceof Error ? error.name : 'unknown error'
        }.`,
      );
      throw new PaystackUnavailableError();
    }

    const payload = asRecord(await response.json().catch(() => undefined));

    if (!response.ok || payload?.status !== true) {
      const message =
        (payload && stringAt(payload, 'message')) ??
        'Paystack returned no message.';

      this.logger.error(
        `Paystack ${method} ${pathForLog(path)} failed with ${response.status}.`,
      );
      throw new PaystackRefusedError(response.status, message);
    }

    return payload.data;
  }
}

/** A path for a log line: the verify path without its reference. */
function pathForLog(path: string): string {
  return path.startsWith('/transaction/verify/')
    ? '/transaction/verify/…'
    : path;
}
