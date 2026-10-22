import {
  ReservationSource,
  ReservationStatus,
  TableSessionStatus,
} from '../../generated/cnc-client';
import {
  NIGERIAN_PHONE,
  canonicalNigerianPhone,
} from '../common/nigerian-phone';
import { watWallClockToUtc } from '../common/wat';
import {
  ARRIVAL_SLOT_MESSAGE,
  CLOSED_DAY_MESSAGE,
  FUTURE_TIME_MESSAGE,
  OPENING_HOURS_MESSAGE,
  bigPartyMessage,
} from './reception-messages';

/**
 * The booking rules that need no database: the arrival time, the hours,
 * the grid and the large-party rule, the table's status word, and the
 * spellings Reception's records use. Pure, so the e2e suite need not wait
 * for a clock to pass a booking time.
 */

/**
 * The statuses that hold a table for the booking's date (plan §4.5), the
 * statuses of the partial unique index `Reservation_tableId_businessDate_key`.
 * One list for the booking command, the floor, the public availability and
 * account deletion, so none of them can disagree on what "booked" means.
 */
export const HOLDING_STATUSES: ReservationStatus[] = [
  ReservationStatus.CONFIRMED,
  ReservationStatus.CHECKED_IN,
];

/** `HH:mm`, zero-padded, 24-hour: the form every arrival time travels in. */
export const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `"19:30"` → 1170, or null for anything that is not `HH:mm`. */
export function clockMinutes(text: string): number | null {
  const match = CLOCK.exec(text);

  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

/** 1170 → `"19:30"`. */
export function clockText(minutes: number): string {
  const hours = Math.floor(minutes / 60);

  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * The instant a booking starts: its date and arrival time on a wall clock
 * in Jos (A11). `businessDate` is a `@db.Date` value (UTC midnight).
 */
export function bookingStart(businessDate: Date, startMinutes: number): Date {
  return watWallClockToUtc(
    businessDate.getUTCFullYear(),
    businessDate.getUTCMonth(),
    businessDate.getUTCDate(),
    Math.floor(startMinutes / 60),
    startMinutes % 60,
  );
}

/** One day's opening hours (`OpeningHoursDay`). */
export interface DayHours {
  isClosed: boolean;
  opensAtMinutes: number | null;
  closesAtMinutes: number | null;
}

/** The two timing settings the website's arrival list is built from. */
export interface ArrivalSettings {
  lastArrivalMinutes: number;
  slotStepMinutes: number;
}

/** The website and the app: the channels the arrival grid binds (Q30). */
function isOnline(source: ReservationSource): boolean {
  return source !== ReservationSource.RECEPTION;
}

/**
 * Whether a booking's arrival is one the channel may book, or the sentence
 * that refuses it (400), in this order:
 *
 * 1. In the future: Reception's demo rule is "not before now"
 *    (`>=`); the website lists only times after the current minute, so an
 *    online booking must be later than now.
 * 2. On a day the opening hours do not mark closed.
 * 3. Within the day's hours, from opening to before closing (Q30's
 *    default: Reception is limited to the opening hours, 08:00 to 23:59).
 * 4. Online only (Q30: "the 30-minute grid and 23:00 last arrival apply to
 *    web and app only"): on the grid from opening, every
 *    `slotStepMinutes`, and no later than `lastArrivalMinutes`.
 */
export function arrivalProblem(input: {
  source: ReservationSource;
  businessDate: Date;
  startMinutes: number;
  now: Date;
  hours: DayHours;
  settings: ArrivalSettings;
}): string | null {
  const { source, businessDate, startMinutes, now, hours, settings } = input;
  const start = bookingStart(businessDate, startMinutes).getTime();
  const future = isOnline(source)
    ? start > now.getTime()
    : start >= now.getTime();

  if (!future) return FUTURE_TIME_MESSAGE;

  if (
    hours.isClosed ||
    hours.opensAtMinutes === null ||
    hours.closesAtMinutes === null
  ) {
    return CLOSED_DAY_MESSAGE;
  }

  if (
    startMinutes < hours.opensAtMinutes ||
    startMinutes >= hours.closesAtMinutes
  ) {
    return OPENING_HOURS_MESSAGE;
  }

  if (
    isOnline(source) &&
    (startMinutes > settings.lastArrivalMinutes ||
      (startMinutes - hours.opensAtMinutes) % settings.slotStepMinutes !== 0)
  ) {
    return ARRIVAL_SLOT_MESSAGE;
  }

  return null;
}

/**
 * The arrival times a website or app guest is offered on `businessDate`,
 * as `HH:mm`, earliest first (`GET /venues/:venue/availability`): every
 * minute from the day's opening to its closing that `arrivalProblem`
 * accepts for an online booking, on the grid. Built from that one rule, so
 * a time offered is a time the booking command takes. Today's passed
 * times are dropped, as the website's `arrivalSlots` drops them.
 */
export function arrivalTimes(input: {
  businessDate: Date;
  now: Date;
  hours: DayHours;
  settings: ArrivalSettings;
}): string[] {
  const { hours } = input;

  if (
    hours.isClosed ||
    hours.opensAtMinutes === null ||
    hours.closesAtMinutes === null
  ) {
    return [];
  }

  const times: string[] = [];

  for (
    let minutes = hours.opensAtMinutes;
    minutes < hours.closesAtMinutes;
    minutes += input.settings.slotStepMinutes
  ) {
    const problem = arrivalProblem({
      ...input,
      source: ReservationSource.WEB,
      startMinutes: minutes,
    });

    if (problem === null) times.push(clockText(minutes));
  }

  return times;
}

/** What the website shows a table as (plan §5.1, §7.5). */
export const PUBLIC_TABLE_STATUSES = [
  'AVAILABLE',
  'RESERVED',
  'OCCUPIED',
  'BLOCKED',
] as const;

export type PublicTableStatus = (typeof PUBLIC_TABLE_STATUSES)[number];

/**
 * A floor status as the website names it: a Locked table is "blocked"
 * (plan §7.5; the website shows it as Unavailable), and nothing of why it
 * is locked leaves the staff app.
 */
export function publicTableStatus(status: FloorStatus): PublicTableStatus {
  return status === 'LOCKED' ? 'BLOCKED' : status;
}

/**
 * The large-party rule: a website or app booking for `bigParty` guests or
 * more goes to the team instead (plan Q7: 4+ Dining, 5+ Lounge), refused
 * with the website's own note. Reception is the team, so it is never
 * refused for size here; the table's places still bind it.
 */
export function bigPartyProblem(
  source: ReservationSource,
  party: number,
  bigParty: number,
): string | null {
  return isOnline(source) && party >= bigParty
    ? bigPartyMessage(bigParty)
    : null;
}

/**
 * How a guest's phone is kept: a Nigerian mobile number, typed with or
 * without spaces or dashes, in the one form CNC stores (`0` plus 10 digits,
 * `canonicalNigerianPhone`), so the Q35 link and a search find it however
 * it was typed; anything else (a visitor's foreign number) as typed. The
 * demo required only that a phone was given.
 */
export function guestPhone(text: string): string {
  const compact = text.replace(/[\s-]/g, '');

  return NIGERIAN_PHONE.test(compact)
    ? canonicalNigerianPhone(compact)
    : text.trim();
}

/**
 * A table's reference in the history and the staff app: the room's
 * initial and the table's code, `D-B1`, `L-TS1` (the demo's own table
 * ids). Codes repeat across rooms (TS1 to TS3), so the code alone is not
 * one table.
 */
export function tableRef(venueStaffName: string, code: string): string {
  return `${venueStaffName.charAt(0).toUpperCase()}-${code}`;
}

/** What Reception's floor shows a table as (plan §7.5). */
export const FLOOR_STATUSES = [
  'AVAILABLE',
  'OCCUPIED',
  'RESERVED',
  'LOCKED',
] as const;

export type FloorStatus = (typeof FLOOR_STATUSES)[number];

/**
 * A table's status on a date (plan §7.5, the demo's `tableStatus`):
 * Locked whenever a Locked session holds it; Occupied when guests are
 * seated and the date is today (a session is now, so it does not occupy a
 * future evening); Reserved when a Confirmed or Checked In booking holds
 * the date; otherwise Available.
 */
export function floorStatus(input: {
  session: TableSessionStatus | null;
  isToday: boolean;
  booked: boolean;
}): FloorStatus {
  if (input.session === TableSessionStatus.LOCKED) return 'LOCKED';
  if (input.session === TableSessionStatus.OCCUPIED && input.isToday) {
    return 'OCCUPIED';
  }

  return input.booked ? 'RESERVED' : 'AVAILABLE';
}
