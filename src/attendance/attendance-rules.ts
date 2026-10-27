import { createHash, timingSafeEqual } from 'node:crypto';
import {
  addDays,
  daysBetween,
  formatIsoDate,
  parseIsoDate,
} from '../common/calendar-date';
import { watToday, watWallClockToUtc } from '../common/wat';
import { STAFF_QR_PREFIX } from '../staff/staff-qr';
import {
  MAX_PERIOD_DAYS,
  MONTH_MESSAGE,
  PERIOD_DATES_MESSAGE,
  PERIOD_LENGTH_MESSAGE,
  PERIOD_ORDER_MESSAGE,
  SCAN_CODE_MAX_LENGTH,
} from './attendance-messages';

/**
 * The attendance rules (plan §4.7, §7.9; Q12's default: timestamps only),
 * pure, from the demo's `attendance.scan`, `attendance.correct` and
 * `staff/lib/attendance.ts`, so each is unit-tested without a database.
 * Nothing here knows about lateness, leave or pay.
 */

/** A repeat scan of one person within a minute of their last is ignored (§7.9). */
export const REPEAT_SCAN_WINDOW_MS = 60_000;

/** The shift filters of the attendance screens, as the API spells them. */
export const SHIFT_FILTERS = ['ALL', 'COMPLETED', 'OPEN'] as const;

export type ShiftFilter = (typeof SHIFT_FILTERS)[number];

/** A staff ID's two parts, as scanned. */
export interface StaffCode {
  staffNo: string;
  token: string;
}

/**
 * Read a scanned code: `CNC-ID:<staff number>:<token>` (`staffQrPayload`),
 * trimmed, as a camera or a USB scanner sends it (a scanner ends its text
 * with a line break). Null for anything else, which the scan refuses with
 * its one sentence.
 */
export function parseStaffCode(code: unknown): StaffCode | null {
  if (typeof code !== 'string') return null;

  const text = code.trim();

  if (text.length > SCAN_CODE_MAX_LENGTH || !text.startsWith(STAFF_QR_PREFIX)) {
    return null;
  }

  const parts = text.slice(STAFF_QR_PREFIX.length).split(':');

  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;

  return { staffNo: parts[0], token: parts[1] };
}

/**
 * Whether a scanned token is the account's, compared in constant time over
 * SHA-256 digests (equal lengths whatever was sent), so the time a refusal
 * takes says nothing about how much of a token was right.
 */
export function tokensMatch(stored: string, scanned: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();

  return timingSafeEqual(digest(stored), digest(scanned));
}

/** A shift as the rules read it. */
export interface Shift {
  timeIn: Date;
  timeOut: Date | null;
}

/** What a scan does. */
export type ScanStep = 'REPEAT' | 'CHECK_OUT' | 'CHECK_IN';

/**
 * The demo's scan, given the person's latest shift (by arrival) and their
 * open one: within a minute of the last scan (the latest shift's departure,
 * else its arrival) the scan is a repeat and changes nothing; otherwise an
 * open shift closes, whenever it began (an overnight shift closes on the
 * next scan, §7.9), and with none open a new one starts.
 */
export function scanStep(
  latest: Shift | null,
  open: Shift | null,
  now: Date,
): ScanStep {
  if (latest !== null) {
    const lastScan = latest.timeOut ?? latest.timeIn;

    if (now.getTime() - lastScan.getTime() < REPEAT_SCAN_WINDOW_MS) {
      return 'REPEAT';
    }
  }

  return open === null ? 'CHECK_IN' : 'CHECK_OUT';
}

/** `YYYY-MM-DDTHH:mm`, as a `datetime-local` field sends a Lagos wall clock. */
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The instant a Lagos wall clock reads (A11: the client sends a date and a
 * time and the server builds the instant). Null for anything that is not a
 * real day and a 24-hour time.
 */
export function parseWatWallClock(value: unknown): Date | null {
  if (typeof value !== 'string') return null;

  const match = WALL_CLOCK.exec(value.trim());
  const day = match === null ? null : parseIsoDate(match[1]);

  if (match === null || day === null) return null;

  return watWallClockToUtc(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    Number(match[2]),
    Number(match[3]),
  );
}

/**
 * The demo's overlap test: two shifts of one person overlap when each
 * starts before the other ends, an open shift running until now.
 */
export function overlaps(a: Shift, b: Shift, now: Date): boolean {
  const aEnd = a.timeOut ?? now;
  const bEnd = b.timeOut ?? now;

  return a.timeIn < bEnd && aEnd > b.timeIn;
}

/** A period of business dates, both ends included. */
export interface Period {
  from: Date;
  to: Date;
}

/**
 * The demo's `monthPeriod`: the first and last day of a `YYYY-MM` month,
 * leap years included. Throws the demo's sentence for anything else.
 */
export function monthPeriod(month: string): Period {
  const first = /^\d{4}-\d{2}$/.test(month)
    ? parseIsoDate(`${month}-01`)
    : null;

  if (first === null) throw new Error(MONTH_MESSAGE);

  const next = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1),
  );

  return { from: first, to: addDays(next, -1) };
}

/**
 * The demo's `validatePeriod`, plus a ceiling of {@link MAX_PERIOD_DAYS}:
 * real start and end dates, the end on or after the start. Throws the
 * demo's sentence.
 */
export function validatePeriod(from: unknown, to: unknown): Period {
  const start = typeof from === 'string' ? parseIsoDate(from) : null;
  const end = typeof to === 'string' ? parseIsoDate(to) : null;

  if (start === null || end === null) throw new Error(PERIOD_DATES_MESSAGE);
  if (start > end) throw new Error(PERIOD_ORDER_MESSAGE);
  if (daysBetween(start, end) + 1 > MAX_PERIOD_DAYS) {
    throw new Error(PERIOD_LENGTH_MESSAGE);
  }

  return { from: start, to: end };
}

/**
 * The period a read covers: `from` and `to` when either is sent, else the
 * month sent, else this month in Lagos (the demo's `currentMonth`). Throws
 * the demo's sentence.
 */
export function periodFor(
  query: { month?: string; from?: string; to?: string },
  now: Date,
): Period {
  if (query.from !== undefined || query.to !== undefined) {
    return validatePeriod(query.from, query.to);
  }

  return monthPeriod(query.month ?? formatIsoDate(watToday(now)).slice(0, 7));
}

/** A completed shift's length in hours (the demo's `shiftHours`); 0 while open. */
export function shiftHours(shift: Shift): number {
  return shift.timeOut === null
    ? 0
    : Math.max(
        0,
        (shift.timeOut.getTime() - shift.timeIn.getTime()) / 3_600_000,
      );
}

/** Hours to two decimal places, as the screens print them. */
export function roundHours(hours: number): number {
  return Math.round(hours * 100) / 100;
}

/** The figures over a person's shifts in a period. */
export interface AttendanceSummary {
  days: number;
  shifts: number;
  completed: number;
  open: number;
  hours: number;
  corrections: number;
}

/**
 * The demo's `attendanceSummary`: days with an arrival counted once, shifts,
 * completed and open shifts, completed hours (open shifts add none: hours
 * are never estimated), and corrections. Hours are summed exactly and then
 * rounded to two places.
 */
export function attendanceSummary(
  rows: readonly (Shift & { businessDate: Date; corrections: number })[],
): AttendanceSummary {
  return {
    days: new Set(rows.map((row) => row.businessDate.getTime())).size,
    shifts: rows.length,
    completed: rows.filter((row) => row.timeOut !== null).length,
    open: rows.filter((row) => row.timeOut === null).length,
    hours: roundHours(rows.reduce((sum, row) => sum + shiftHours(row), 0)),
    corrections: rows.reduce((sum, row) => sum + row.corrections, 0),
  };
}
