/**
 * Reception's sentences: table sessions and reservations (card C4-7).
 *
 * The demo's sentences are byte for byte from `staff/lib/domain.ts`
 * (`reservation.create`, `checkin`, `cancel`, `noshow`, `table.allocate`,
 * `table.release`), and the website's from `components/booking/
 * TableBooking.tsx` and `lib/booking/engine.ts` in `cnc-frontend` (A7): the
 * screens show them as they stand. The ones marked new answer a case the
 * demo never met; each says why.
 */

/** `reservation.create`: a blank guest name or phone number (400). */
export const GUEST_NAME_PHONE_MESSAGE =
  'Enter the guest name and phone number.';

/** `reservation.create`: a missing or malformed guest email (400). */
export const GUEST_EMAIL_MESSAGE =
  'Enter the guest email so the confirmation can be sent.';

/**
 * `reservation.create`: no such table, a party below one, or a party above
 * the table's places (400). The demo answers all three in one sentence.
 */
export const CAPACITY_MESSAGE = 'Choose a position with enough capacity.';

/** `reservation.create`: an arrival before now (400). */
export const FUTURE_TIME_MESSAGE = 'Select a future reservation time.';

/**
 * `reservation.create`: the table already has a Confirmed or Checked In
 * booking that date (409). Answered from the check, and from the partial
 * unique index `Reservation_tableId_businessDate_key` when two bookings
 * race.
 */
export const ALREADY_RESERVED_MESSAGE =
  'This position is already reserved for that date. A booking keeps its table until staff free it.';

/**
 * The same clash for a booking made from the website or the app (409,
 * plan §5.1), in the website's own words.
 */
export const TAKEN_ONLINE_MESSAGE =
  'Someone has just taken this place for that time. Go back to the floor plan and choose another.';

/** `reservation.create` on a Locked table (409). */
export const TABLE_LOCKED_MESSAGE = 'This position is locked.';

/** `reservation.create` for today on a table with guests seated (409). */
export const GUESTS_SEATED_MESSAGE =
  'Guests are at this position now. Free it before booking it for today.';

/** `reservation.checkin` on a booking that is not Confirmed (409). */
export const CHECKIN_CONFIRMED_MESSAGE = 'Select a confirmed reservation.';

/** `reservation.checkin` on any day but the booking's own (409). */
export const CHECKIN_DATE_MESSAGE = 'Check-in must be on the reservation date.';

/** `reservation.checkin` on a table that is Occupied or Locked (409). */
export const CHECKIN_ALLOCATED_MESSAGE =
  'Release the existing table allocation first.';

/** `reservation.cancel` on a booking that is not Confirmed (409). */
export const CANCEL_CONFIRMED_MESSAGE =
  'Only confirmed reservations can be cancelled.';

/** `reservation.cancel` at or after the booking time (409). */
export const CANCEL_TIME_MESSAGE =
  'Cancel before the booking time. Later, mark the booking as a no show.';

/** `reservation.noshow` on a booking that is not Confirmed (409). */
export const NOSHOW_CONFIRMED_MESSAGE =
  'Only confirmed reservations can be marked as a no show.';

/** `reservation.noshow` before the booking time has passed (409). */
export const NOSHOW_TIME_MESSAGE = 'The booking time has not passed yet.';

/** `table.allocate` and `table.release`: no such table (404). */
export const TABLE_NOT_FOUND_MESSAGE = 'Table not found.';

/**
 * `table.allocate` on a table that already has a session (409). Answered
 * from the check, and from the partial unique index
 * `TableSession_tableId_key` when two allocations race.
 */
export const ALREADY_ALLOCATED_MESSAGE =
  'Release this position before allocating it again.';

/** `table.allocate` with a status other than Occupied or Locked (400). */
export const TABLE_STATUS_MESSAGE = 'Invalid table status.';

/** `table.allocate` on a table with a Confirmed booking today (409). */
export const TABLE_RESERVED_MESSAGE =
  'This position is reserved. Check in or resolve the reservation first.';

/** `table.allocate` Occupied without a guest, or a party outside 1 to the table's places (400). */
export const SEAT_GUESTS_MESSAGE =
  'Enter a guest name and a party size within capacity.';

/** `table.allocate` Locked without a reason (400). */
export const LOCK_REASON_MESSAGE = 'Enter a reason for locking this position.';

/** `table.release` on a table with no session (409). */
export const NO_ALLOCATION_MESSAGE = 'No active allocation.';

/** `table.release` while a bill on the table is Open or awaiting payment, of any date (409; plan §7.1 step 6). */
export const UNSETTLED_ORDERS_MESSAGE =
  'There are unsettled orders for this position. Settle them before release.';

/**
 * A reservation id that matches nothing (404). New: the demo answered a
 * missing booking with each command's state sentence ("Select a confirmed
 * reservation."); the server's version claim needs one not-found sentence,
 * in the form of "Order not found.".
 */
export const RESERVATION_NOT_FOUND_MESSAGE = 'Reservation not found.';

/**
 * A missing or impossible booking date (400). New: the demo compared the
 * text it was given and refused a nonsense date as "not in the future".
 */
export const RESERVATION_DATE_MESSAGE = 'Enter a valid reservation date.';

/** A time that is not `HH:mm` (400). New, for the same reason. */
export const ARRIVAL_TIME_MESSAGE = 'Enter a valid arrival time.';

/**
 * A booking for a day the opening hours mark closed (400). New with the
 * opening hours (D26, Q30): the demo had no hours.
 */
export const CLOSED_DAY_MESSAGE =
  'CNC is closed on that date. Choose another date.';

/**
 * A Reception arrival outside the day's opening hours (400). New: Q30's
 * default limits Reception to the opening hours (08:00 to 23:59 today);
 * the demo let Reception book any minute, even 03:00 (D24).
 */
export const OPENING_HOURS_MESSAGE =
  'Choose an arrival time within opening hours.';

/**
 * A website or app arrival off the arrival grid or after the last arrival
 * (400). New: the website only ever offers times on the grid, so a request
 * with another one did not come from its time list (Q30: the grid and the
 * last arrival apply to the web and the app only).
 */
export const ARRIVAL_SLOT_MESSAGE = 'Choose one of the arrival times offered.';

/**
 * `reservation.change` on a booking that is not Confirmed (409). New with
 * the command (plan §16: no staff command changed a booking), in the form
 * of the cancel sentence.
 */
export const CHANGE_CONFIRMED_MESSAGE =
  'Only confirmed reservations can be changed.';

/**
 * `GET /staff/floor?venue=` naming a room that does not exist (400). New:
 * the demo's floor chose between its two rooms on screen.
 */
export const VENUE_MESSAGE = 'Choose a venue.';

/** The longest guest name, phone and email a booking keeps. */
export const GUEST_NAME_MAX_LENGTH = 120;
export const GUEST_PHONE_MAX_LENGTH = 40;
export const GUEST_EMAIL_MAX_LENGTH = 254;
/** The longest booking note, lock reason or seated guest description. */
export const RECEPTION_NOTE_MAX_LENGTH = 500;

/** The numbers the website spells in its large-party note. */
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

/**
 * A website or app booking for a party at or above the room's `bigParty`
 * (400): the website's `bigNote`, byte for byte, built from the room's
 * threshold ("For four or more guests…" in Dining, "five" in the Lounge).
 * Such a party goes to the team as a group enquiry (plan Q7, "Large
 * groups"); Reception is the team, so its bookings are never refused for
 * size beyond the table's places.
 */
export function bigPartyMessage(bigParty: number): string {
  const count = NUMBER_WORDS[bigParty] ?? String(bigParty);

  return `For ${count} or more guests, speak to our team and we will arrange suitable seating.`;
}
