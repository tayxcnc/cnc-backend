/**
 * West Africa Time, as an offset from UTC.
 *
 * Nigeria is UTC+1 all year and has never observed daylight saving, so a fixed
 * offset is not an approximation — it is the whole rule, and it is why this
 * project does the arithmetic itself rather than carrying a timezone database.
 *
 * Shared rather than owned by one module. A business date, an opening-hours
 * check and a reservation's start all need the same number, and copying it
 * would leave several constants that must agree forever with nothing forcing
 * them to. The failure would be silent: an hour's disagreement only shows up
 * between midnight and one in the morning.
 *
 * Time comes from the server only (plan A11). Clients send a date and a
 * `"HH:mm"` time; the server builds the instant with the functions below.
 */
export const WAT_OFFSET_MINUTES = 60;

const MINUTE_MS = 60 * 1000;

/** The same offset in milliseconds, which is the form the arithmetic wants. */
export const WAT_OFFSET_MS = WAT_OFFSET_MINUTES * MINUTE_MS;

/**
 * The UTC instant at which a West African wall-clock time occurs.
 *
 * The calendar fields describe a clock on a wall in Jos; the returned `Date`
 * is the ordinary UTC instant that clock reads at. Every column in the database
 * is UTC and every comparison downstream is in UTC — only the question "what
 * does the wall say" is asked in local time.
 *
 * `Date.UTC` is used rather than the `Date` constructor deliberately. The
 * constructor reads its arguments in the host's timezone, which is UTC on Cloud
 * Run and something else on every developer's laptop, so a value built with it
 * would be correct in production and wrong in a test run in Nigeria.
 *
 * @param year full year, e.g. 2026
 * @param month zero-based, matching `Date.UTC`
 * @param day one-based day of the month
 */
export function watWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
): Date {
  return new Date(Date.UTC(year, month, day, hours, minutes) - WAT_OFFSET_MS);
}

/** `"HH:mm"`, zero-padded, 24-hour. The form every stored time uses. */
const WALL_CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The instant a `"HH:mm"` wall clock reads on a given calendar date.
 *
 * A reservation stores a date and a time; opening hours store a day and two
 * times. Each then asks the same question — has it started yet — and must ask
 * it in Nigerian time, because a table booked for eight in the evening is
 * booked for eight in the evening whatever timezone a server happens to run in.
 *
 * `calendarDate` is a `@db.Date` value, which Prisma hands back at UTC
 * midnight, so its date fields are read with the `UTC` getters.
 *
 * Throws rather than returning null on a malformed time. The `"HH:mm"` format
 * is a promise the schema makes and the seeds keep; a row that breaks it is a
 * data defect, and answering a request as though the thing simply could not be
 * found would hide it.
 */
export function watInstantAt(calendarDate: Date, time: string): Date {
  const match = WALL_CLOCK.exec(time);

  if (match === null) {
    throw new Error(
      `Time "${time}" is not zero-padded 24-hour "HH:mm". Every read of a ` +
        `timetable depends on that format.`,
    );
  }

  return watWallClockToUtc(
    calendarDate.getUTCFullYear(),
    calendarDate.getUTCMonth(),
    calendarDate.getUTCDate(),
    Number(match[1]),
    Number(match[2]),
  );
}

/**
 * The instant a span that started at `startTime` on `calendarDate` ends.
 *
 * **This exists because `watInstantAt(date, endTime)` is wrong** for any span
 * that crosses midnight. A bar open from 18:00 to 01:00, or a sitting whose
 * stored `endTime` is `"00:00"`, ends on the *following* morning. Paired with
 * the calendar date by `watInstantAt`, that end reads as the **start** of the
 * date — hours before the span began — and everything downstream believes it
 * ended before it started.
 *
 * The rule: add a day when the end is not after the start. It is stated in
 * terms of the two stored strings rather than a duration, so a span that does
 * not cross midnight takes the same path and comes back unchanged.
 *
 * A separate function rather than a flag on `watInstantAt`, so that reaching
 * for the wrong one is visible at the call site: `watInstantAt` takes one time
 * and cannot know whether it is a start or an end, and a caller that has an
 * end time has to name this function to use it.
 */
export function watSessionEnd(
  calendarDate: Date,
  startTime: string,
  endTime: string,
): Date {
  // Both are converted, so both are validated — a malformed start time throws
  // here rather than quietly losing a string comparison and moving the end of
  // a span by a day.
  const start = watInstantAt(calendarDate, startTime);
  const end = watInstantAt(calendarDate, endTime);

  return end > start ? end : new Date(end.getTime() + 24 * 60 * MINUTE_MS);
}

/**
 * The calendar fields a West African clock shows at an instant.
 *
 * Returned as a `Date` shifted into WAT, to be read with the `UTC` getters —
 * `getUTCFullYear`, `getUTCDate`, `getUTCDay` — which now describe the local
 * date because the shift has already happened. Reading `getMonth`/`getDate`
 * instead would answer for whatever timezone the process happens to run in.
 *
 * The returned value is **not** a meaningful instant and must not be stored or
 * compared against one. It is a carrier for six calendar fields.
 */
export function watCalendarFields(instant: Date): Date {
  return new Date(instant.getTime() + WAT_OFFSET_MS);
}

/**
 * Today's date in Nigeria, shaped like a `@db.Date` value.
 *
 * The boundary between "today" and "yesterday" for a business date, and it is
 * not UTC's boundary. For an hour every night the two disagree: at 00:30 on
 * Tuesday in Jos it is still Monday in UTC, so a window built from the UTC
 * date opens with a day that has already finished.
 *
 * Returned at UTC midnight so it compares directly against a `@db.Date` column.
 */
export function watToday(now: Date): Date {
  const local = watCalendarFields(now);

  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()),
  );
}
