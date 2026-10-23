import { applyDecorators, HttpException, HttpStatus } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { type Prisma, ReservationSource } from '../../generated/cnc-client';
import {
  AUTH_ATTEMPT_WINDOW_MS,
  THROTTLERS,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from '../auth/auth-throttle';

/**
 * Bookings per client address in the window (fifteen minutes) on
 * `POST /reservations`, counted in memory per instance (A18): the first
 * line only, which turns a burst away before it reaches the database. The
 * real limits are the stored caps below (`assertOnlineBookingCaps`), which
 * hold across instances and restarts. Answered with
 * `TOO_MANY_ATTEMPTS_MESSAGE` (429).
 */
export const BOOKING_ADDRESS_LIMIT = 30;

/** `POST /reservations`: the address only. */
export function BookingThrottle(): MethodDecorator {
  return applyDecorators(
    Throttle({
      [THROTTLERS.address]: {
        limit: BOOKING_ADDRESS_LIMIT,
        ttl: AUTH_ATTEMPT_WINDOW_MS,
      },
    }),
    SkipThrottle({
      [THROTTLERS.account]: true,
      [THROTTLERS.accountAnywhere]: true,
    }),
  );
}

/** The window the stored booking caps count over: a day. */
export const BOOKING_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Website and app bookings one client address may make in a day, counted
 * on the stored rows (`Reservation.ipHash`). The route needs no sign-in and
 * each booking holds a table for a whole date, so without a stored number
 * one script, restarting instances or not, could hold every table in both
 * rooms for weeks. A guest books once or twice; twenty leaves room for a
 * mobile carrier's NAT or the venue's Wi-Fi shared by many guests.
 */
export const BOOKING_ADDRESS_DAILY_LIMIT = 20;

/**
 * Website and app bookings one email may be given in a day, from any
 * address. Each booking emails that address, so this is what a stranger can
 * push into someone's inbox through CNC's sender. A person booking several
 * dates for themselves stays far below it.
 *
 * There is no cap per phone: CNC sends no SMS, so a phone receives nothing,
 * and valid-looking numbers cost a script nothing to make up, while a cap
 * would refuse a family booking under one number.
 */
export const BOOKING_EMAIL_DAILY_LIMIT = 10;

type Tx = Prisma.TransactionClient;

/**
 * The stored caps on online bookings (`WEB` and `APP`; Reception's are
 * staff's and never counted), in the booking's transaction: at most
 * `BOOKING_ADDRESS_DAILY_LIMIT` per address and `BOOKING_EMAIL_DAILY_LIMIT`
 * per email in `BOOKING_CAP_WINDOW_MS`. 429 with `TOO_MANY_ATTEMPTS_MESSAGE`.
 *
 * Taken under advisory locks on the address and the email, in a fixed order
 * and before the booking command takes its table's lock, so requests
 * arriving together cannot each count the others' rows as not there yet.
 * No other path takes these keys, so they cannot deadlock with the table
 * or the email locks.
 */
export async function assertOnlineBookingCaps(
  tx: Tx,
  caps: { ipHash: string; email: string },
  now: Date,
): Promise<void> {
  const keys = [
    `cnc:booking-cap:address:${caps.ipHash}`,
    `cnc:booking-cap:email:${caps.email}`,
  ].sort();

  for (const key of keys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  const since = new Date(now.getTime() - BOOKING_CAP_WINDOW_MS);
  const online = { in: [ReservationSource.WEB, ReservationSource.APP] };

  const fromAddress = await tx.reservation.count({
    where: { ipHash: caps.ipHash, createdAt: { gt: since } },
  });

  if (fromAddress >= BOOKING_ADDRESS_DAILY_LIMIT) {
    throw new HttpException(
      TOO_MANY_ATTEMPTS_MESSAGE,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  const toEmail = await tx.reservation.count({
    where: { email: caps.email, source: online, createdAt: { gt: since } },
  });

  if (toEmail >= BOOKING_EMAIL_DAILY_LIMIT) {
    throw new HttpException(
      TOO_MANY_ATTEMPTS_MESSAGE,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
