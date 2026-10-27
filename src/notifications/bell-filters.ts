import { type Prisma, ReservationStatus } from '../../generated/cnc-client';
import { watToday } from '../common/wat';
import { UNSETTLED_ORDER_STATUSES } from '../orders/order-rules';

/**
 * Which rows two of the bell's kinds count, as filters of their own: the
 * bell reads them (`StaffNotificationsService`) and so do the push sweep's
 * daily digests (C10, PS11 and PS13), so a digest's count is always the
 * bell's.
 */

/** Expected Guest Arrival: today's Confirmed bookings in Lagos. */
export function expectedArrivalsWhere(now: Date) {
  return {
    businessDate: watToday(now),
    status: ReservationStatus.CONFIRMED,
  } satisfies Prisma.ReservationWhereInput;
}

/** Unsettled From a Previous Day: Open or Payment bills before today. */
export function unsettledBillsWhere(now: Date) {
  return {
    status: { in: UNSETTLED_ORDER_STATUSES },
    businessDate: { lt: watToday(now) },
  } satisfies Prisma.OrderWhereInput;
}
