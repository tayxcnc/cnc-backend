/**
 * CNC's weekly opening hours: the rules a week must keep, and the shape it
 * is answered in. TAY's `opening-hours.ts`, copied (plan §4.1, D26: TAY's
 * model and response shape). Pure functions, so the unit suite covers them
 * without a database, and the DTO, the service and the tests share one copy.
 */

/** A week has seven days, 0 = Sunday … 6 = Saturday, as `getDay()` counts. */
export const DAYS_IN_WEEK = 7;

/** Midnight at the end of a day, in minutes. The latest a day may close. */
export const MINUTES_IN_DAY = 24 * 60;

/** Day names for messages and the audit row, indexed by `dayOfWeek`. */
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * One day as it is stored and answered: WAT minutes from midnight, null
 * exactly when the day is closed.
 */
export type OpeningHoursDayValue = {
  dayOfWeek: number;
  isClosed: boolean;
  opensAtMinutes: number | null;
  closesAtMinutes: number | null;
};

/** One day as a request may send it: the times may be absent or null. */
export interface OpeningHoursDayInput {
  dayOfWeek: number;
  isClosed: boolean;
  opensAtMinutes?: number | null;
  closesAtMinutes?: number | null;
}

/** The answer, before it is serialised. */
export interface OpeningHoursValue {
  isSet: boolean;
  days: OpeningHoursDayValue[] | null;
  updatedAt: Date | null;
}

const isWholeMinute = (value: unknown, min: number, max: number) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

const isDayShaped = (day: unknown): day is OpeningHoursDayInput => {
  if (typeof day !== 'object' || day === null) return false;

  const candidate = day as Record<string, unknown>;
  const timeShaped = (value: unknown) =>
    value === undefined ||
    value === null ||
    isWholeMinute(value, 0, MINUTES_IN_DAY);

  return (
    isWholeMinute(candidate.dayOfWeek, 0, DAYS_IN_WEEK - 1) &&
    typeof candidate.isClosed === 'boolean' &&
    timeShaped(candidate.opensAtMinutes) &&
    timeShaped(candidate.closesAtMinutes)
  );
};

/**
 * What is wrong with a week as a whole, or null when nothing is.
 *
 * Judges only what the per-field rules cannot: a day sent as a list, every
 * day exactly once, a closed day with no times, an open day with both,
 * opening before closing. A list with an entry the field rules refuse is
 * not judged here (null), so a malformed entry is reported once.
 *
 * A closed day that carries times is refused rather than having them
 * dropped: the Owner who ticked Closed by mistake would otherwise lose the
 * times without being told.
 */
export function weekRuleBroken(days: unknown): string | null {
  if (Array.isArray(days) && days.some((day) => Array.isArray(day))) {
    return 'days must send each day as an object, not as a list.';
  }

  if (!Array.isArray(days) || !days.every(isDayShaped)) return null;

  const named = new Set(days.map((day) => day.dayOfWeek));

  if (days.length !== DAYS_IN_WEEK || named.size !== DAYS_IN_WEEK) {
    return (
      'days must name each day of the week exactly once, from 0 (Sunday) ' +
      'to 6 (Saturday).'
    );
  }

  for (const day of [...days].sort((a, b) => a.dayOfWeek - b.dayOfWeek)) {
    const name = DAY_NAMES[day.dayOfWeek];
    const opens = day.opensAtMinutes ?? null;
    const closes = day.closesAtMinutes ?? null;

    if (day.isClosed) {
      if (opens !== null || closes !== null) {
        return `${name} is closed, so it takes no opening or closing time.`;
      }
      continue;
    }

    if (opens === null || closes === null) {
      return (
        `${name} is open, so it needs both opensAtMinutes and ` +
        'closesAtMinutes.'
      );
    }

    if (opens >= closes) {
      return (
        `${name} must close after it opens. A day closes no later than ` +
        `midnight (${MINUTES_IN_DAY}).`
      );
    }
  }

  return null;
}

/**
 * A request's week as rows, in day order, with absent times as null. Call
 * only on a week `weekRuleBroken` passed.
 */
export function toStoredWeek(
  days: OpeningHoursDayInput[],
): OpeningHoursDayValue[] {
  return [...days]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((day) => ({
      dayOfWeek: day.dayOfWeek,
      isClosed: day.isClosed,
      opensAtMinutes: day.isClosed ? null : (day.opensAtMinutes ?? null),
      closesAtMinutes: day.isClosed ? null : (day.closesAtMinutes ?? null),
    }));
}

/**
 * The rows as a route answers them. Anything but seven rows is "not set":
 * CNC's migration seeds all seven and every write replaces all seven in one
 * transaction, so fewer would mean a damaged table, and showing a partial
 * week would say CNC is closed on days nobody entered.
 *
 * `updatedAt` is the newest row's, which is when the week was last written.
 */
export function toOpeningHours(
  rows: (OpeningHoursDayValue & { updatedAt: Date })[],
): OpeningHoursValue {
  if (rows.length !== DAYS_IN_WEEK) {
    return { isSet: false, days: null, updatedAt: null };
  }

  const ordered = [...rows].sort((a, b) => a.dayOfWeek - b.dayOfWeek);
  const updatedAt = new Date(
    Math.max(...ordered.map((row) => row.updatedAt.getTime())),
  );

  return {
    isSet: true,
    days: ordered.map((row) => ({
      dayOfWeek: row.dayOfWeek,
      isClosed: row.isClosed,
      opensAtMinutes: row.opensAtMinutes,
      closesAtMinutes: row.closesAtMinutes,
    })),
    updatedAt,
  };
}

/**
 * The hours of the week day `calendarDate` falls on (a `@db.Date`-shaped
 * value, read with `getUTCDay`). A week that is not set, or a day missing
 * from it, is closed: a day nobody entered is not a day CNC promises to be
 * open.
 */
export function hoursOn(
  days: OpeningHoursDayValue[] | null,
  calendarDate: Date,
): OpeningHoursDayValue {
  const dayOfWeek = calendarDate.getUTCDay();

  return (
    days?.find((day) => day.dayOfWeek === dayOfWeek) ?? {
      dayOfWeek,
      isClosed: true,
      opensAtMinutes: null,
      closesAtMinutes: null,
    }
  );
}

/** `570` → `09:30`; `1440` → `24:00` (midnight at the end of the day). */
export function minutesLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * A week as the activity history reads it: one plain field per day
 * (`monday: "08:00–24:00"` or `"Closed"`), so a changed day reads
 * "Monday changed from 08:00–24:00 to Closed." rather than "Days changed
 * from 7 entries to 7 entries."
 */
export function weekForAudit(
  days: OpeningHoursDayValue[] | null,
): Record<string, string> | null {
  if (days === null) return null;

  return Object.fromEntries(
    days.map((day) => [
      DAY_NAMES[day.dayOfWeek].toLowerCase(),
      day.isClosed ||
      day.opensAtMinutes === null ||
      day.closesAtMinutes === null
        ? 'Closed'
        : `${minutesLabel(day.opensAtMinutes)}–${minutesLabel(day.closesAtMinutes)}`,
    ]),
  );
}
