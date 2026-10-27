/**
 * The payment sentences (C7). All new: the website's demo took no real
 * payment, so it has none to keep.
 */

/**
 * `POST /checkouts` while CNC's Paystack key is unset or a placeholder
 * (503): the order page offers the phone instead.
 */
export const ONLINE_PAYMENT_UNAVAILABLE_MESSAGE =
  'Online payment is not available just now. Please call CNC to order.';

/** A webhook delivery whose signature is missing or wrong (401). TAY's. */
export const INVALID_SIGNATURE_MESSAGE = 'Invalid webhook signature.';

/**
 * Paystack could not be reached while starting a checkout's payment (503).
 * The checkout waits: the same Idempotency-Key tries again.
 */
export const PAYMENT_PROVIDER_UNREACHABLE_MESSAGE =
  'We could not reach our payment provider. Please try again in a moment.';

/**
 * Paystack refused to start a checkout's payment (502). The checkout is
 * closed `FAILED`; a new checkout (a new Idempotency-Key) starts again.
 */
export const PAYMENT_START_FAILED_MESSAGE =
  'We could not start the payment. Please check your details and place the order again.';
