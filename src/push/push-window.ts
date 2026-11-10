import { addDays } from '../common/calendar-date';
import { watDayBounds, watToday } from '../common/wat';
import { hoursOn, type OpeningHoursDayValue } from '../settings/opening-hours';

/**
 * When a non-urgent staff push may ring a phone (C10, D6). Pure, with `now`
 * injected, so a spec walks every edge.
 *
 * The staff window is the Lagos day's opening hours (`OpeningHoursDay`,
 * seeded 08:00 to midnight) widened by `STAFF_WINDOW_GRACE_MIN` on each
 * side: staff arrive before the doors open and close up after. A week with
 * no open day at all (hours never set, or every day closed) falls back to
 * `FALLBACK_WINDOW`, so a push is held, not lost.
 *
 * Only a staff push whose event is not urgent and whose recipient is not on
 * duty is held, to the next window's opening (`holdUntil`): an urgent one
 * (a paid web order, a held payment) must reach someone, and someone on
 * duty is at work whatever the clock says. Customer pushes are never held:
 * they come from staff actions during service, or the reminder of an
 * in-hours booking. TAY's fixed 05:00 to 23:00 window would hold a 22:30
 * "ready for pickup".
 */

/** Minutes each side of the opening hours a staff push may still ring. */
export const STAFF_WINDOW_GRACE_MIN = 60;

/** The window, in WAT minutes after midnight, when no day is open. */
export const FALLBACK_WINDOW = {
  opensAtMinutes: 7 * 60,
  closesAtMinutes: 22 * 60,
};

const MINUTE_MS = 60 * 1000;

/** One window, as instants: `opensAt` inclusive, `closesAt` exclusive. */
export interface StaffWindow {
  opensAt: Date;
  closesAt: Date;
}

/** Whether any day of the week is open. */
function anyDayOpen(days: OpeningHoursDayValue[] | null): boolean {
  return (days ?? []).some(
    (day) =>
      !day.isClosed &&
      day.opensAtMinutes !== null &&
      day.closesAtMinutes !== null,
  );
}

/** The window of one Lagos calendar date, or null on a closed day. */
function windowOn(
  days: OpeningHoursDayValue[] | null,
  calendarDate: Date,
  fallback: boolean,
): StaffWindow | null {
  const { start } = watDayBounds(calendarDate);
  let opens: number;
  let closes: number;

  if (fallback) {
    opens = FALLBACK_WINDOW.opensAtMinutes;
    closes = FALLBACK_WINDOW.closesAtMinutes;
  } else {
    const day = hoursOn(days, calendarDate);

    if (
      day.isClosed ||
      day.opensAtMinutes === null ||
      day.closesAtMinutes === null
    ) {
      return null;
    }

    opens = day.opensAtMinutes - STAFF_WINDOW_GRACE_MIN;
    closes = day.closesAtMinutes + STAFF_WINDOW_GRACE_MIN;
  }

  return {
    opensAt: new Date(start.getTime() + opens * MINUTE_MS),
    closesAt: new Date(start.getTime() + closes * MINUTE_MS),
  };
}

/**
 * The windows of the Lagos dates from `fromDay` days to `toDay` days after
 * today, in order. Yesterday's is included because a day open to midnight
 * runs its grace past it; tomorrow's because a day opening before 01:00
 * starts its grace the evening before.
 */
function windowsAround(
  days: OpeningHoursDayValue[] | null,
  now: Date,
  fromDay: number,
  toDay: number,
): StaffWindow[] {
  const today = watToday(now);
  const fallback = !anyDayOpen(days);
  const windows: StaffWindow[] = [];

  for (let offset = fromDay; offset <= toDay; offset += 1) {
    const window = windowOn(days, addDays(today, offset), fallback);

    if (window !== null) windows.push(window);
  }

  return windows;
}

/** The staff window `now` falls in, or null outside every window. */
export function staffWindow(
  days: OpeningHoursDayValue[] | null,
  now: Date,
): StaffWindow | null {
  return (
    windowsAround(days, now, -1, 1).find(
      (window) => window.opensAt <= now && now < window.closesAt,
    ) ?? null
  );
}

/**
 * The first window opening after `now`. A week always has one: either a
 * day is open, or the fallback opens every day.
 */
export function nextStaffWindowOpen(
  days: OpeningHoursDayValue[] | null,
  now: Date,
): Date {
  const next = windowsAround(days, now, -1, 8).find(
    (window) => window.opensAt > now,
  );

  if (next === undefined) {
    throw new Error('No staff window opens in the next week.');
  }

  return next.opensAt;
}

/**
 * When a staff push written at `now` may first be sent, or null to send it
 * at once (D6): null for an urgent event, for a recipient on duty, and
 * inside a staff window; otherwise the next window's opening.
 */
export function holdUntil(args: {
  urgent: boolean;
  onDuty: boolean;
  days: OpeningHoursDayValue[] | null;
  now: Date;
}): Date | null {
  if (args.urgent || args.onDuty) return null;
  if (staffWindow(args.days, args.now) !== null) return null;

  return nextStaffWindowOpen(args.days, args.now);
}
