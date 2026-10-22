/**
 * The cash count's sentences, byte for byte from `staff/lib/domain.ts`
 * (A7): `cash.count`. The screens show them as they stand.
 */

/** `cash.count`: a counted figure that is not a whole number of kobo, zero or more (400). */
export const CASH_COUNT_MESSAGE = 'Enter a valid cash count.';

/** `cash.count` for a date after today in Lagos (400). */
export const CASH_FUTURE_MESSAGE = 'Cannot reconcile a future date.';

/**
 * `cash.count` with no date, or one that is not a real `YYYY-MM-DD` day
 * (400). New: the demo compared whatever the date field held as text; the
 * sentence names the screen's own field, "Reconciliation Date".
 */
export const CASH_DATE_MESSAGE = 'Enter a valid reconciliation date.';
