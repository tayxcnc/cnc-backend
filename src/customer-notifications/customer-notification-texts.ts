import { CustomerNotificationKind } from '../../generated/cnc-client';
import { bookingDateText, clockText } from '../reception/reservation-rules';

/**
 * The words of the customer's in-app list (plan §9.2, card C6-8), as the
 * account app's demo wrote them (`lib/account/api.ts` `listNotifications`)
 * wherever it had them. Pure, so a spec pins every sentence.
 *
 * `link` is a path under `CNC_WEB_URL` without `/cnc` (the account app's
 * section), never a full URL: the frontend joins it to its own base, so
 * the stored row does not go stale when the domain changes.
 */
export interface NotificationText {
  kind: CustomerNotificationKind;
  title: string;
  body: string;
  link: string | null;
}

/** Where the account app lists bookings. */
export const RESERVATIONS_LINK = '/account#reservations';

/** The first item in a new account's list (the demo's "welcome"). */
export const WELCOME_NOTIFICATION: NotificationText = {
  kind: CustomerNotificationKind.ACCOUNT,
  title: 'Welcome to CNC',
  body: 'Your orders and your table reservations now live in one place.',
  link: null,
};

/** Where the account app shows one order: its tracker. */
export function orderLink(number: string): string {
  return `/account#order/${number}`;
}

/** A web order event the in-app list records (C7-6). */
export type OrderNotificationEvent =
  | 'RECEIVED'
  | 'PREPARING'
  | 'ON_THE_WAY'
  | 'READY'
  | 'DELIVERED'
  | 'COLLECTED'
  | 'CANCELLED';

/**
 * The demo's order body: the first two dishes' names, "and more" past
 * two, and a full stop ("Jollof Rice, Chapman and more.").
 */
export function orderLinesText(names: readonly string[]): string {
  return `${names.slice(0, 2).join(', ')}${names.length > 2 ? ' and more' : ''}.`;
}

/**
 * A web order's notification (C7-6). The demo's titles where it had them
 * ("Order CNCR-000124 received", "… delivered", "… collected") and its
 * body (`orderLinesText`); the stages in between and the cancellation are
 * new, in the same shape, because the demo built the item on read and
 * never showed them.
 */
export function orderNotification(
  event: OrderNotificationEvent,
  number: string,
  lineNames: readonly string[],
): NotificationText {
  const title = {
    RECEIVED: `Order ${number} received`,
    PREPARING: `Order ${number} is being prepared`,
    ON_THE_WAY: `Order ${number} is on its way`,
    READY: `Order ${number} is ready for pickup`,
    DELIVERED: `Order ${number} delivered`,
    COLLECTED: `Order ${number} collected`,
    CANCELLED: `Order ${number} cancelled`,
  }[event];

  return {
    kind: CustomerNotificationKind.ORDER,
    title,
    body: orderLinesText(lineNames),
    link: orderLink(number),
  };
}

/**
 * Money given back on a web order (C7-6, new): "Refund for order
 * CNCR-000124", with the amount and how it came back.
 */
export function refundNotification(
  number: string,
  amount: string,
  method: 'CARD' | 'CASH' | 'TRANSFER',
): NotificationText {
  const how = {
    CARD: 'to your card',
    CASH: 'in cash',
    TRANSFER: 'by bank transfer',
  }[method];

  return {
    kind: CustomerNotificationKind.ORDER,
    title: `Refund for order ${number}`,
    body: `${amount} given back ${how}.`,
    link: orderLink(number),
  };
}

/** A booking event the in-app list records. */
export type BookingNotificationEvent =
  'confirmed' | 'changed' | 'cancelled' | 'reminder';

/** What a booking notification says about the booking. */
export interface BookingNotificationDetails {
  tableName: string;
  /** The room's customer title: "Dining", "Lounge". */
  venueTitle: string;
  /** The booking's `@db.Date`. */
  businessDate: Date;
  startMinutes: number;
}

/**
 * A booking's notification. The demo's titles for a booking made
 * ("Table reserved") and cancelled ("Reservation cancelled"), and its
 * body: "<table>, <room>, <date> at <time>.". "Reservation changed" is new
 * (the demo could not change a booking's time from Reception). The
 * reminder keeps the demo's "See you soon" and its sentence, with the
 * booking's date and time in place of "today or tomorrow", which the demo
 * wrote because it built the item on read.
 */
export function bookingNotification(
  event: BookingNotificationEvent,
  details: BookingNotificationDetails,
): NotificationText {
  const date = bookingDateText(details.businessDate);
  const time = clockText(details.startMinutes);

  if (event === 'reminder') {
    return {
      kind: CustomerNotificationKind.BOOKING,
      title: 'See you soon',
      body:
        `Your table in the ${details.venueTitle} is booked for ${date} at ` +
        `${time}. Your table is yours for your whole visit.`,
      link: RESERVATIONS_LINK,
    };
  }

  const title = {
    confirmed: 'Table reserved',
    changed: 'Reservation changed',
    cancelled: 'Reservation cancelled',
  }[event];

  return {
    kind: CustomerNotificationKind.BOOKING,
    title,
    body: `${details.tableName}, ${details.venueTitle}, ${date} at ${time}.`,
    link: RESERVATIONS_LINK,
  };
}
