import { CustomerNotificationKind } from '../../generated/cnc-client';
import { parseIsoDate } from '../common/calendar-date';
import {
  RESERVATIONS_LINK,
  WELCOME_NOTIFICATION,
  bookingNotification,
  orderLinesText,
  orderNotification,
  refundNotification,
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

  it('names an order’s stages, the demo’s titles where it had them (C7-6)', () => {
    expect(
      orderNotification('RECEIVED', 'CNCR-000124', [
        'Jollof Rice',
        'Chapman',
        'Suya',
      ]),
    ).toEqual({
      kind: CustomerNotificationKind.ORDER,
      title: 'Order CNCR-000124 received',
      body: 'Jollof Rice, Chapman and more.',
      link: '/account#order/CNCR-000124',
    });
    expect(
      orderNotification('DELIVERED', 'CNCR-000124', ['Jollof Rice']),
    ).toMatchObject({
      title: 'Order CNCR-000124 delivered',
      body: 'Jollof Rice.',
    });
    expect(orderNotification('COLLECTED', 'CNCR-1', ['A', 'B']).title).toBe(
      'Order CNCR-1 collected',
    );
    expect(orderNotification('ON_THE_WAY', 'CNCR-1', ['A']).title).toBe(
      'Order CNCR-1 is on its way',
    );
    expect(orderNotification('CANCELLED', 'CNCR-1', ['A']).title).toBe(
      'Order CNCR-1 cancelled',
    );
    expect(orderLinesText(['A', 'B'])).toBe('A, B.');
  });

  it('records a refund with the amount and how it came back', () => {
    expect(refundNotification('CNCR-1', '₦3,225.00', 'CARD')).toEqual({
      kind: CustomerNotificationKind.ORDER,
      title: 'Refund for order CNCR-1',
      body: '₦3,225.00 given back to your card.',
      link: '/account#order/CNCR-1',
    });
    expect(refundNotification('CNCR-1', '₦1.00', 'TRANSFER').body).toBe(
      '₦1.00 given back by bank transfer.',
    );
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
