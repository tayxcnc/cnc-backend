import { AddressThrottle } from '../auth/auth-throttle';

/**
 * The limits on the two enquiry forms (card C6-7), in two layers, so that
 * defeating one does not defeat both (TAY's contact form: the throttle and
 * the honeypot live apart):
 *
 * 1. **Stored enquiries per client address: at most
 *    `ENQUIRY_ADDRESS_LIMIT` in `ENQUIRY_WINDOW_MS`, both forms together,
 *    counted on the `Enquiry` rows (`ipHash`)** under an advisory lock on
 *    the address. Rows hold across instances and restarts. Each accepted
 *    enquiry is an email
 *    into CNC's one inbox; a person writes once or twice, so five an hour
 *    leaves room for a correction and a second question, and keeps a
 *    script from burying the inbox.
 * 2. **Requests per address to each form: `ENQUIRY_REQUEST_LIMIT` in
 *    fifteen minutes** (`EnquiryThrottle`, stored from C8-3 like every
 *    throttle; the throttler keys its counts
 *    by route), the first line, which also counts what stores nothing:
 *    refused bodies and honeypot hits.
 *
 * Both answer `TOO_MANY_ATTEMPTS_MESSAGE` (429).
 */
export const ENQUIRY_ADDRESS_LIMIT = 5;
export const ENQUIRY_WINDOW_MS = 60 * 60 * 1000;

/** Requests per address to each form in fifteen minutes. */
export const ENQUIRY_REQUEST_LIMIT = 20;

/**
 * How long an enquiry's email may wait for a send (the outbound queue's
 * `expiresAt`): a week, not the default day. The enquiry is the thing of
 * value and is stored either way, but with no staff list (Q20) the email
 * is how CNC reads it, so a late one beats none.
 */
export const ENQUIRY_MAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** `POST /enquiries` and `POST /group-enquiries`: the address only. */
export function EnquiryThrottle(): MethodDecorator {
  return AddressThrottle(ENQUIRY_REQUEST_LIMIT);
}

/**
 * Whether the honeypot was filled in (TAY's rule): anything that is not
 * absent, null or blank text. A bot may send a number, an array or an
 * object; all mean the same thing, something filled a field no person can
 * see.
 */
export function isHoneypotFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;

  if (typeof value === 'string') return value.trim() !== '';

  return true;
}
