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

/**
 * The month abbreviations the staff app prints. They are what
 * `toLocaleString('en-GB', { month: 'short' })` gives on Node 22 and current
 * browsers, `Sept` included.
 */
const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sept',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * `05 Oct, 18:30` — the staff app's `timeLabel` (`staff/lib/domain.ts`):
 * the Nigerian day and wall clock at an instant, day and time zero-padded.
 * The audit sentences print a changed timestamp this way, as the staff app
 * did.
 */
export function formatWatShortStamp(instant: Date): string {
  const local = watCalendarFields(instant);
  const day = String(local.getUTCDate()).padStart(2, '0');

  return `${day} ${SHORT_MONTHS[local.getUTCMonth()]}, ${formatWatClock(instant)}`;
}

/** `18:30` — the wall clock in Nigeria at an instant, zero-padded 24-hour. */
export function formatWatClock(instant: Date): string {
  const local = watCalendarFields(instant);
  const hours = String(local.getUTCHours()).padStart(2, '0');
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');

  return `${hours}:${minutes}`;
}
