import { watCalendarFields } from './wat';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * `6 September 2026` — the date a calendar in Nigeria shows at an instant.
 *
 * Unambiguous to a reader in any country, which matters in two places: a
 * confirmation a customer forwards to someone else, and a sentence a staff
 * member reads aloud to a guest. Day-first numeric dates are read the other
 * way round by half the people who might see them.
 *
 * Computed with the fixed WAT offset rather than `Intl` and a timezone name,
 * for the reason `src/common/wat.ts` gives: Nigeria has one offset all year,
 * so the arithmetic is the whole rule.
 */
export function formatWatLongDate(instant: Date): string {
  const local = watCalendarFields(instant);

  return `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()}`;
}

/** `18:30` — the wall clock in Nigeria at an instant, zero-padded 24-hour. */
export function formatWatClock(instant: Date): string {
  const local = watCalendarFields(instant);
  const hours = String(local.getUTCHours()).padStart(2, '0');
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');

  return `${hours}:${minutes}`;
}
