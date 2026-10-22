import { applyDecorators } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { AUTH_ATTEMPT_WINDOW_MS, THROTTLERS } from '../auth/auth-throttle';

/**
 * Bookings per client address in the window (fifteen minutes) on
 * `POST /reservations`. The route needs no sign-in and holds a table for a
 * whole date and sends an email, so without a number one script could book
 * every table in both rooms for a month or mail any address at will. A
 * real guest books once or twice; thirty leaves room for a family sharing
 * one connection and for the venue's Wi-Fi, without letting the floor be
 * emptied from one address. Counted in memory per instance (A18), as every
 * CNC limit is, and answered with `TOO_MANY_ATTEMPTS_MESSAGE` (429).
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
