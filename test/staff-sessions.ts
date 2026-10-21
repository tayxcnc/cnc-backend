import { randomBytes } from 'node:crypto';
import type request from 'supertest';
import { STAFF_REFRESH_COOKIE } from '../src/auth/refresh-cookie';

/**
 * Helpers for the suites that sign staff in through the real routes (the
 * staff auth suite and the C3 gate walk), so the cookie handling is written
 * once.
 */

/**
 * A fresh client address, as Cloud Run's front end forwards it: the caller,
 * then the front end. `clientAddressOf` takes the caller. A new one per
 * sign-in keeps a suite clear of the per-address sign-in throttle.
 */
export const clientAddress = (): string =>
  `10.${[...randomBytes(3)].join('.')}, 10.255.255.1`;

/** The whole `Set-Cookie` line for the staff refresh cookie, if one was set. */
export function staffRefreshCookieLine(
  response: request.Response,
): string | undefined {
  const lines = response.headers['set-cookie'] as unknown as
    string[] | undefined;

  return lines?.find((line) => line.startsWith(`${STAFF_REFRESH_COOKIE}=`));
}

/** The value of the staff refresh cookie a response set; throws if none. */
export function staffRefreshCookieOf(response: request.Response): string {
  const line = staffRefreshCookieLine(response);

  if (line === undefined) throw new Error('No staff refresh cookie was set.');

  return line.split(';')[0].slice(`${STAFF_REFRESH_COOKIE}=`.length);
}
