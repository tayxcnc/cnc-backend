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
