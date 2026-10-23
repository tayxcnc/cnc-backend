import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Paystack's webhook signature and delivery id, copied from TAY's
 * `webhook-signature.ts` (plan §8.2).
 */

/** The header Paystack signs each delivery with (Node lower-cases it). */
export const PAYSTACK_SIGNATURE_HEADER = 'x-paystack-signature';

/** HMAC-SHA512 hex: 128 characters. */
const SIGNATURE_HEX_LENGTH = 128;

/**
 * Whether a delivery came from Paystack: HMAC-SHA512 over the **raw
 * bytes** (a re-serialised body differs in key order and spacing) under
 * CNC's **secret** key, compared with `timingSafeEqual` (a `===` leaks how
 * much of a guess was right). The length is checked first because
 * `timingSafeEqual` throws on a mismatch; that leaks only the length,
 * which is public. No raw body (the bootstrap option off) is refused,
 * never waved through.
 */
export function isValidPaystackSignature(
  rawBody: Buffer | undefined,
  header: unknown,
  secretKey: string,
): boolean {
  if (rawBody === undefined || rawBody.length === 0) return false;

  if (typeof header !== 'string' || header.length !== SIGNATURE_HEX_LENGTH) {
    return false;
  }

  const expected = createHmac('sha512', secretKey).update(rawBody).digest();
  const presented = Buffer.from(header, 'hex');

  if (presented.length !== expected.length) return false;

  return timingSafeEqual(presented, expected);
}

/**
 * The idempotency key of one delivery: SHA-256 of the raw body, hex.
 * Paystack's envelope carries no event id, and a redelivery is
 * byte-identical, so it hashes the same; not the signature, which changes
 * when the key is rotated (TAY's reasoning).
 */
export function deliveryId(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/** The signature Paystack would send for `body`: for tests and local walks. */
export function signPaystackBody(body: string, secretKey: string): string {
  return createHmac('sha512', secretKey).update(body).digest('hex');
}
