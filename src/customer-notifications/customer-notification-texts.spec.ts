import { CustomerNotificationKind } from '../../generated/cnc-client';
import { parseIsoDate } from '../common/calendar-date';
import {
  RESERVATIONS_LINK,
  WELCOME_NOTIFICATION,
  bookingNotification,
} from './customer-notification-texts';

const DETAILS = {
  tableName: 'Sofa setting 1',
  venueTitle: 'Lounge',
  businessDate: parseIsoDate('2026-10-24')!,
  startMinutes: 19 * 60,
};

describe('customer notification texts', () => {
  it('welcomes a new account in the demo’s words', () => {
    expect(WELCOME_NOTIFICATION).toEqual({
      kind: CustomerNotificationKind.ACCOUNT,
      title: 'Welcome to CNC',
      body: 'Your orders and your table reservations now live in one place.',
      link: null,
    });
  });

  it('names a booking made, changed and cancelled as the demo wrote them', () => {
    const body = 'Sofa setting 1, Lounge, Sat 24 Oct 2026 at 19:00.';

    expect(bookingNotification('confirmed', DETAILS)).toEqual({
      kind: CustomerNotificationKind.BOOKING,
      title: 'Table reserved',
      body,
      link: RESERVATIONS_LINK,
    });
    expect(bookingNotification('changed', DETAILS).title).toBe(
      'Reservation changed',
    );
    expect(bookingNotification('cancelled', DETAILS)).toMatchObject({
      title: 'Reservation cancelled',
      body,
    });
  });

  it('reminds with "See you soon" and the booking’s own date and time', () => {
    expect(
      bookingNotification('reminder', { ...DETAILS, startMinutes: 8 * 60 }),
    ).toEqual({
      kind: CustomerNotificationKind.BOOKING,
      title: 'See you soon',
      body:
        'Your table in the Lounge is booked for Sat 24 Oct 2026 at 08:00. ' +
        'Your table is yours for your whole visit.',
      link: '/account#reservations',
    });
  });
});
