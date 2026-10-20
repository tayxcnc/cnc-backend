/**
 * Calendar dates — days rather than instants.
 *
 * Every business date in this schema is `@db.Date`: the day an order belongs
 * to, the day a reservation is for. Postgres `date` has no time and no zone,
 * and Prisma represents such a value as a `Date` at **UTC midnight**.
 * Everything here builds and reads that representation, so a value from a
 * query and a value parsed from a request body compare equal.
 *
 * Shared in `src/common` because every feature that takes a date asks the
 * same questions of the same column type, and a second copy would be two
 * regexes and two parsers that must agree forever with nothing forcing them
 * to.
 *
 * Nothing here knows about a timezone. Shifting a calendar date into West
 * Africa Time would store the day before — the shift belongs to code asking
 * "when does this start", which is `src/common/wat.ts`, not here.
 */

/** `"YYYY-MM-DD"`. The only form a caller may name a calendar date in. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Read a `"YYYY-MM-DD"` string as a `@db.Date` value, or `null`.
 *
 * Deliberately strict, and deliberately not `@IsDateString`: that accepts
 * `"2026-09-14T23:30:00-05:00"`, which names a moment that is the fifteenth in
 * Nigeria while reading as the fourteenth. There is no timezone a value like
 * that can correctly be resolved against, so refusing it is cheaper than
 * choosing one and being wrong for somebody.
 */
export function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) {
    return null;
  }

  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  // Rejects 2026-02-30, which `Date.UTC` silently rolls into March. Comparing
  // the fields back is the only way to catch it: the constructor does not fail.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return parsed;
}

/** A `@db.Date` value as `"YYYY-MM-DD"`, which is how it is serialised. */
export function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The same calendar date, `days` later. Days, not 24-hour periods. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Whole days from `from` to `to`, negative if `to` is earlier. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}
