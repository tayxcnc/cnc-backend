import {
  OnlineFulfilmentStatus,
  ReservationSource,
} from '../../generated/cnc-client';
import { stagePushEvent } from '../online-orders/online-order-mail';
import { bookingPushEvent } from '../reception/reservation-mail';
import { inDigestWindow } from './staff-clock-alerts';

/**
 * C10's pure choices around the hooks: the digests' hour (PS11, PS13), and
 * which order stage and which booking message pushes the customer. The
 * pushes themselves are proved through the routes (`push-*.e2e-spec.ts`).
 * Instants are written in UTC; Jos is an hour ahead all year.
 */
describe('the daily digests’ hour', () => {
  it.each([
    ['2026-10-30T07:59:59.000Z', false],
    ['2026-10-30T08:00:00.000Z', true],
    ['2026-10-30T08:59:59.000Z', true],
    ['2026-10-30T09:00:00.000Z', false],
    // 09:30 UTC is 10:30 in Jos.
    ['2026-10-30T09:30:00.000Z', false],
  ])('at %s is %s', (iso, expected) => {
    expect(inDigestWindow(new Date(iso))).toBe(expected);
  });
});

describe('which order stage pushes the customer (PC1 to PC4)', () => {
  it.each([
    [OnlineFulfilmentStatus.RECEIVED, null],
    [OnlineFulfilmentStatus.PREPARING, 'order.preparing'],
    [OnlineFulfilmentStatus.ON_THE_WAY, 'order.on_the_way'],
    [OnlineFulfilmentStatus.READY, 'order.ready'],
    [OnlineFulfilmentStatus.DELIVERED, null],
    [OnlineFulfilmentStatus.COLLECTED, null],
    [OnlineFulfilmentStatus.CANCELLED, 'order.cancelled'],
  ])('%s gives %s', (status, event) => {
    expect(stagePushEvent(status)).toBe(event);
  });
});

describe('which booking message pushes the customer (PC6 to PC9)', () => {
  it('pushes a confirmation only for a booking Reception made', () => {
    expect(
      bookingPushEvent('confirmed', ReservationSource.RECEPTION, false),
    ).toBe('reservation.booked_for_you');
    expect(bookingPushEvent('confirmed', ReservationSource.WEB, false)).toBe(
      null,
    );
    expect(bookingPushEvent('confirmed', ReservationSource.APP, false)).toBe(
      null,
    );
  });

  it('pushes a change or a cancellation only when staff made it', () => {
    for (const source of Object.values(ReservationSource)) {
      expect(bookingPushEvent('changed', source, true)).toBe(
        'reservation.changed_by_staff',
      );
      expect(bookingPushEvent('changed', source, false)).toBeNull();
      expect(bookingPushEvent('cancelled', source, true)).toBe(
        'reservation.cancelled_by_staff',
      );
      expect(bookingPushEvent('cancelled', source, false)).toBeNull();
    }
  });

  it('always offers the reminder; Reservation Reminders decides at the queue', () => {
    expect(bookingPushEvent('reminder', ReservationSource.APP, false)).toBe(
      'reservation.reminder',
    );
  });
});
