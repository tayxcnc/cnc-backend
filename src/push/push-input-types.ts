import { formatIsoDate } from '../common/calendar-date';
import { formatWatClock } from '../common/wat-format';
import { watToday } from '../common/wat';
import { DOCKET_REF_PREFIX } from '../orders/docket-items';
import { clockText } from '../reception/reservation-rules';

/**
 * The only kinds of text a push may carry (C10, D2): each a branded string
 * that only the constructor below it makes.
 *
 * A push is shown on a lock screen, to whoever holds the device, and is
 * stored as rendered text for its retries. So the catalogue's inputs
 * (`PushInputs`) are ids, numbers that identify a record, labels built from
 * dates and times, names from lists staff manage (a room, a table, a stock
 * item), counts and enums: **never a plain `string`**, which
 * `push-catalogue.ts` refuses at compile time. A guest's name, a phone, an
 * email, an address, a note, a task title or a payment reference cannot
 * reach a push without someone writing a new brand here, in review.
 *
 * Each constructor checks the shape it can check and throws otherwise; the
 * queue's pure step catches that and writes no push (`PushQueueService`).
 */

declare const PUSH_INPUT: unique symbol;

/** A string that only this file's constructor `Name` makes. */
type Branded<Name extends string> = string & { readonly [PUSH_INPUT]: Name };

/** A record's id (a cuid): never shown, only keyed on. */
export type Id = Branded<'Id'>;

/** An order number: `WEB-000124` or `CNCR-000124`. */
export type OrderNumber = Branded<'OrderNumber'>;

/** A kitchen docket's ref: `KOT-CNCR-000124`. */
export type DocketRef = Branded<'DocketRef'>;

/** A purchase's number: `PR-000012`. */
export type PurchaseRef = Branded<'PurchaseRef'>;

/** A room's staff name, from the venues staff manage. */
export type RoomName = Branded<'RoomName'>;

/** A table's name, from the tables staff manage. */
export type TableName = Branded<'TableName'>;

/** A stock item's name, from the items staff manage. */
export type StockItemName = Branded<'StockItemName'>;

/** A business date as a push says it: `Fri 30 Oct`. */
export type WatDateLabel = Branded<'WatDateLabel'>;

/** A wall-clock time in Jos: `19:30`. */
export type WatTimeLabel = Branded<'WatTimeLabel'>;

/** A Lagos business day as a key: `2026-10-30`. Never shown. */
export type WatDay = Branded<'WatDay'>;

function brand<Name extends string>(
  kind: Name,
  value: string,
  shape: RegExp,
): Branded<Name> {
  if (!shape.test(value)) {
    throw new Error(`A push input is not a valid ${kind}.`);
  }

  return value as Branded<Name>;
}

/** Names from a staff-managed list: any non-blank text, at most 120. */
const LISTED_NAME = /^\S(?:.{0,118}\S)?$/s;

export const asId = (value: string): Id =>
  brand('Id', value, /^[A-Za-z0-9_-]{1,64}$/);

export const asOrderNumber = (value: string): OrderNumber =>
  brand('OrderNumber', value, /^[A-Z]+-\d{6,}$/);

export const asDocketRef = (value: string): DocketRef =>
  brand('DocketRef', value, new RegExp(`^${DOCKET_REF_PREFIX}[A-Z]+-\\d{6,}$`));

export const asPurchaseRef = (value: string): PurchaseRef =>
  brand('PurchaseRef', value, /^PR-\d{6,}$/);

export const asRoomName = (value: string): RoomName =>
  brand('RoomName', value, LISTED_NAME);

export const asTableName = (value: string): TableName =>
  brand('TableName', value, LISTED_NAME);

export const asStockItemName = (value: string): StockItemName =>
  brand('StockItemName', value, LISTED_NAME);

/**
 * A business date (`@db.Date`, UTC midnight) as `Fri 30 Oct`: the booking
 * date without its year, which a push about this week never needs.
 */
export function watDateLabel(businessDate: Date): WatDateLabel {
  const label = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
    .format(businessDate)
    .replace(/,/g, '');

  return brand(
    'WatDateLabel',
    label,
    /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2,3}$/,
  );
}

/** Minutes after midnight in Jos (a booking's arrival) as `19:30`. */
export const watTimeLabel = (minutes: number): WatTimeLabel =>
  brand('WatTimeLabel', clockText(minutes), /^\d{2}:\d{2}$/);

/** The wall clock in Jos at an instant, as `19:30`. */
export const watClockLabel = (instant: Date): WatTimeLabel =>
  brand('WatTimeLabel', formatWatClock(instant), /^\d{2}:\d{2}$/);

/** The Lagos business day `now` falls on, as `2026-10-30`. */
export const watDay = (now: Date): WatDay =>
  brand('WatDay', formatIsoDate(watToday(now)), /^\d{4}-\d{2}-\d{2}$/);
