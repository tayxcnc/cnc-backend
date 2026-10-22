/**
 * The attendance sentences, byte for byte from the demo's
 * `attendance.scan` and `attendance.correct` (`staff/lib/domain.ts`) and
 * its period helpers (`staff/lib/attendance.ts`), A7. The screens show
 * them as they stand. Sentences marked new have no demo original.
 */

/**
 * A scanned code that is not a CNC staff ID, names no account, carries the
 * wrong token, or belongs to a deactivated account: one sentence for all
 * four, so the scanner says nothing about which part was wrong.
 */
export const SCAN_INVALID_MESSAGE =
  'This staff QR code is invalid or the account is inactive.';

/** A check-out scan earlier than the shift's arrival (409). */
export const CHECKOUT_AFTER_ARRIVAL_MESSAGE = 'Check-out must follow arrival.';

/** An attendance record id that names nothing (404). */
export const ATTENDANCE_NOT_FOUND_MESSAGE = 'Attendance record not found.';

/** A correction's time in or time out that is not a real Lagos date and time. */
export const ATTENDANCE_TIMES_MESSAGE = 'Enter valid attendance times.';

/** A correction's time in or time out after now. */
export const ATTENDANCE_FUTURE_MESSAGE = 'Attendance cannot be in the future.';

/** A correction whose time out is before its time in. */
export const CHECKOUT_AFTER_CHECKIN_MESSAGE = 'Check-out must follow check-in.';

/** A correction that would overlap another of the person's shifts (409). */
export const ATTENDANCE_OVERLAP_MESSAGE =
  'This correction overlaps another shift.';

/** A period whose start or end is not a real date. */
export const PERIOD_DATES_MESSAGE = 'Choose valid start and end dates.';

/** A period that ends before it starts. */
export const PERIOD_ORDER_MESSAGE = 'The end date must follow the start date.';

/** A month that is not a real `YYYY-MM`. */
export const MONTH_MESSAGE = 'Choose a valid month.';

/**
 * A period longer than {@link MAX_PERIOD_DAYS} (400). New: the demo read its
 * records from the browser; a server read needs a ceiling.
 */
export const PERIOD_LENGTH_MESSAGE = 'Choose a period of 366 days or fewer.';

/** A shift filter that is not All Shifts, Completed or Open Shifts (400). New. */
export const SHIFT_FILTER_MESSAGE =
  'Choose All Shifts, Completed or Open Shifts.';

/** The most days one attendance read or export covers. */
export const MAX_PERIOD_DAYS = 366;

/**
 * The export's title (Q12's default: the staff app's "Payroll review",
 * renamed). Attendance is timestamps only; the export calculates no pay.
 */
export const ATTENDANCE_EXPORT_TITLE = 'Attendance review';

/** The export's columns, the staff app's `reportColumns`, in order. */
export const ATTENDANCE_EXPORT_COLUMNS = [
  'Date',
  'Staff ID',
  'Name',
  'Time In',
  'Time Out',
  'Hours',
  'Status',
  'Corrections',
] as const;

/** Longest scanned code accepted; anything longer is not a staff ID. */
export const SCAN_CODE_MAX_LENGTH = 200;
