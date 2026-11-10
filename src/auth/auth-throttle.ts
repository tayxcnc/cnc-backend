import { applyDecorators } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { clientAddressOf } from '../common/client-address';
import { normaliseEmail } from '../common/normalise-email';
import {
  CUSTOMER_PRINCIPAL_KEY,
  type CustomerRequest,
} from './customer-principal';
import { STAFF_PRINCIPAL_KEY, type StaffRequest } from './staff-principal';

/**
 * Rate limits for the staff credential routes, and from C6 to C8-3 every
 * other public or customer write. TAY's numbers (plan §11: ten per fifteen
 * minutes), **counted by account rather than by address**. The table of
 * every route and its limits is in `docs/conventions.md`, *Rate limits*.
 *
 * TAY counts every credential route per client address, which suits TAY's
 * few staff. CNC's staff work in one building, and every till, tablet,
 * kitchen screen and staff phone on the venue's network reaches Cloud Run
 * from one public address. Counted per address, the eleventh person signing
 * in at a shift change was refused, and anyone on the guest Wi-Fi could send
 * ten bad sign-ins and lock every staff member in the building out, again
 * and again. So each route counts what it protects:
 *
 * - **Sign-in** counts the submitted email at the caller's address (ten: a
 *   person mistyping, never their colleagues), the email from anywhere
 *   (thirty: a guessing run spread across addresses, or one that can choose
 *   its address, still meets a number), and the address over all emails
 *   (a hundred: a shift change of thirty people with typos is far below it,
 *   while a run spraying one password across every account, or spending the
 *   server's argon2 work on made-up emails, is not).
 * - **Change-password and the admin reset** count the signed-in account,
 *   after `CncStaffGuard` has verified who that is: ten per person, from any
 *   address. A request without a valid token is refused before it is
 *   counted, so nobody can spend another person's attempts.
 * - **Refresh** counts the address only, at a ceiling far above what a venue
 *   of devices produces (each refreshes about every fifteen minutes, plus
 *   reloads), because a refused refresh signs a real person out. The token
 *   is 256 random bits and single-use, so there is nothing to guess; the
 *   ceiling only keeps an unauthenticated, state-changing route a number.
 *
 * Counts are per route, and from C8-3 they are stored (`RateLimitStore`,
 * the throttler's storage): every Cloud Run instance counts against the
 * same number, where the in-memory count of plan A18 gave each instance
 * its own and forgot it on a restart.
 *
 * Applied per route with `@UseGuards(ClientAddressThrottlerGuard)` and one
 * of the decorators below, never as an APP_GUARD: a global guard would put
 * every staff read under the sign-in limit, silently.
 */

/** The window every count below runs over, in milliseconds. Fifteen minutes. */
export const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Attempts per account in the window: sign-in per email at one address,
 * change-password and the admin reset per signed-in account. Generous
 * enough for a person mistyping three times; tight enough that guessing one
 * account's password gets ten tries, not ten thousand.
 */
export const AUTH_ATTEMPT_LIMIT = 10;

/** Sign-ins per email from every address together, in the window. */
export const SIGN_IN_ACCOUNT_LIMIT = 30;

/** Sign-ins per address over every email, in the window. */
export const SIGN_IN_ADDRESS_LIMIT = 100;

/** Refreshes per address in the window. */
export const REFRESH_ATTEMPT_LIMIT = 600;

/**
 * The named counts `ThrottlerModule` registers (`cnc-auth.module.ts`). Every
 * route under `ClientAddressThrottlerGuard` runs every one of them unless it
 * skips it, so each decorator below names all three.
 */
export const THROTTLERS = {
  /** Keyed by the client address. */
  address: 'address',
  /** Keyed by the account, at the address for sign-in. */
  account: 'account',
  /** Keyed by the submitted email alone. */
  accountAnywhere: 'accountAnywhere',
} as const;

/**
 * The refusal every throttled route answers with (429). A fixed sentence,
 * because the screens show a refusal's message verbatim; the throttler's own
 * default ("ThrottlerException: Too Many Requests") names a class.
 */
export const TOO_MANY_ATTEMPTS_MESSAGE =
  'Too many attempts. Wait a few minutes and try again.';

/**
 * The submitted sign-in email, as the sign-in DTO will normalise it.
 *
 * Read from the raw body, because the throttler runs before the validation
 * pipe. Anything that is not a string counts under one empty key, which is
 * a 400 anyway.
 */
function submittedEmail(req: Record<string, unknown>): string {
  const body = req.body;
  const email =
    typeof body === 'object' && body !== null
      ? normaliseEmail((body as Record<string, unknown>).email)
      : undefined;

  return typeof email === 'string' ? email : '';
}

/** Sign-in, per email at the caller's address. */
export function signInAtAddressTracker(req: Record<string, unknown>): string {
  return `${clientAddressOf(req)}|${submittedEmail(req)}`;
}

/** Sign-in, per email from anywhere. */
export function signInAnywhereTracker(req: Record<string, unknown>): string {
  return submittedEmail(req);
}

/**
 * The signed-in account, as `CncStaffGuard` verified it.
 *
 * Throws when the guard has not run, which is a route listing the throttler
 * before `CncStaffGuard`: counting on the token's unverified claim would let
 * anyone spend a named person's attempts with a forged token, and counting
 * everyone in one bucket would bring back the venue-wide lockout. The e2e
 * suite runs each such route, so the mistake cannot ship quietly.
 */
export function signedInStaffTracker(req: Record<string, unknown>): string {
  const principal = (req as StaffRequest)[STAFF_PRINCIPAL_KEY];

  if (principal === undefined) {
    throw new Error(
      'signedInStaffTracker ran before CncStaffGuard. List the throttler ' +
        'after the staff guard on this route.',
    );
  }

  return principal.id;
}

/**
 * The signed-in customer, as `CncCustomerGuard` verified it. Throws when the
 * guard has not run, for the reason `signedInStaffTracker` gives.
 */
export function signedInCustomerTracker(req: Record<string, unknown>): string {
  const principal = (req as CustomerRequest)[CUSTOMER_PRINCIPAL_KEY];

  if (principal === undefined) {
    throw new Error(
      'signedInCustomerTracker ran before CncCustomerGuard. List the ' +
        'throttler after the customer guard on this route.',
    );
  }

  return `customer:${principal.id}`;
}

/**
 * Profile saves per signed-in customer in the window (`PATCH /me`). A
 * phone number belongs to one account (`Customer.phone` is unique, plan
 * §4.2), so the 409 for a number already taken says whether that number
 * is a CNC customer's; without a number, one account could test a list
 * of numbers. Thirty leaves room for a person flipping every switch on
 * the Notifications panel twice; a list of numbers needs far more.
 */
export const PROFILE_SAVE_LIMIT = 30;

/**
 * A signed-in customer's write, counted per customer from any address:
 * `limit` in `ttl` milliseconds (fifteen minutes unless given), the other
 * two counts skipped (C8-3). The route lists the throttler after
 * `CncCustomerGuard` (a controller's guard runs before a method's), so a
 * request without a valid token is refused before it is counted, and
 * nobody can spend another customer's count. Per customer rather than per
 * address, because customers share the venue's Wi-Fi and a carrier's NAT.
 */
export function CustomerWriteThrottle(
  limit: number,
  ttl: number = AUTH_ATTEMPT_WINDOW_MS,
): MethodDecorator {
  return applyDecorators(
    Throttle({
      [THROTTLERS.account]: {
        limit,
        ttl,
        getTracker: signedInCustomerTracker,
      },
    }),
    SkipThrottle({
      [THROTTLERS.address]: true,
      [THROTTLERS.accountAnywhere]: true,
    }),
  );
}

/** `PATCH /me`, per customer from any address. */
export function ProfileSaveThrottle(): MethodDecorator {
  return CustomerWriteThrottle(PROFILE_SAVE_LIMIT);
}

/**
 * `POST /auth/sign-out` (the customer's), per customer. A sign-out ends
 * every session, so it needs no number of its own beyond keeping a
 * state-changing route a number.
 */
export const CUSTOMER_SIGN_OUT_LIMIT = 30;

/**
 * `POST /me/photo` and `DELETE /me/photo`, each per customer. An upload is
 * decoded and resized on the server and written to the bucket, the most
 * expensive thing a customer can ask for; twenty is a person trying a few
 * pictures, many times over.
 */
export const CUSTOMER_PHOTO_LIMIT = 20;

/**
 * `DELETE /me`, per customer. A deletion succeeds once; the count only
 * keeps the refused ones (a booking still to come) from being a loop.
 */
export const ACCOUNT_DELETE_LIMIT = 10;

/**
 * `POST /me/notifications/read`, per customer. The app marks the list read
 * each time it is opened; a hundred and twenty in fifteen minutes is far
 * above a person opening it.
 */
export const NOTIFICATIONS_READ_LIMIT = 120;

/**
 * `PATCH /me/reservations/:id` and `POST /me/reservations/:id/cancel`,
 * each per customer. Each change or cancellation emails the customer and
 * takes the table's lock; thirty is far above a person moving a booking
 * around, and a script cycling a table's slots meets it.
 */
export const BOOKING_CHANGE_LIMIT = 30;

/**
 * `POST /me/push/subscriptions` and `DELETE /me/push/subscriptions`, each
 * per customer (C10). A page load syncs the device once, so thirty covers
 * a person re-opening the app all day; anything more is a script probing
 * endpoints.
 */
export const PUSH_SUBSCRIPTION_LIMIT = 30;

/**
 * `POST /staff/push/subscriptions` and `DELETE /staff/push/subscriptions`,
 * each per staff member (C10). The same reason as the customer's, counted
 * per person because the venue's tablets share one address.
 */
export const STAFF_PUSH_SUBSCRIPTION_LIMIT = 30;

/**
 * A signed-in staff member's write, counted per person from any address:
 * `limit` in `ttl` milliseconds (fifteen minutes unless given), the other
 * two counts skipped (C10). `CustomerWriteThrottle`'s staff twin: the
 * route lists the throttler after `CncStaffGuard` (the controller's
 * guard), so a request without a valid token is refused uncounted, and
 * per person rather than per address because every device in the venue
 * shares one.
 */
export function StaffWriteThrottle(
  limit: number,
  ttl: number = AUTH_ATTEMPT_WINDOW_MS,
): MethodDecorator {
  return applyDecorators(
    Throttle({
      [THROTTLERS.account]: {
        limit,
        ttl,
        getTracker: signedInStaffTracker,
      },
    }),
    SkipThrottle({
      [THROTTLERS.address]: true,
      [THROTTLERS.accountAnywhere]: true,
    }),
  );
}

/**
 * A public route counted per client address only: `limit` requests in
 * `ttl` milliseconds (fifteen minutes unless given), the other two counts
 * skipped. The bookings, the enquiries, the checkout and Paystack's
 * webhook each name their own number; one decorator keeps the three named
 * counts listed once, so a new public route cannot forget to skip one and
 * be counted under an account key it has no use for.
 */
export function AddressThrottle(
  limit: number,
  ttl: number = AUTH_ATTEMPT_WINDOW_MS,
): MethodDecorator {
  return applyDecorators(
    Throttle({ [THROTTLERS.address]: { limit, ttl } }),
    SkipThrottle({
      [THROTTLERS.account]: true,
      [THROTTLERS.accountAnywhere]: true,
    }),
  );
}

/** `POST /auth/staff/sign-in`. */
export function SignInThrottle(): MethodDecorator {
  return applyDecorators(
    Throttle({
      [THROTTLERS.address]: {
        limit: SIGN_IN_ADDRESS_LIMIT,
        ttl: AUTH_ATTEMPT_WINDOW_MS,
      },
      [THROTTLERS.account]: {
        limit: AUTH_ATTEMPT_LIMIT,
        ttl: AUTH_ATTEMPT_WINDOW_MS,
        getTracker: signInAtAddressTracker,
      },
      [THROTTLERS.accountAnywhere]: {
        limit: SIGN_IN_ACCOUNT_LIMIT,
        ttl: AUTH_ATTEMPT_WINDOW_MS,
        getTracker: signInAnywhereTracker,
      },
    }),
  );
}

/**
 * Change-password and the admin reset. The route lists
 * `@UseGuards(CncStaffGuard, ClientAddressThrottlerGuard)`, in that order.
 */
export function SignedInCredentialThrottle(): MethodDecorator {
  return applyDecorators(
    Throttle({
      [THROTTLERS.account]: {
        limit: AUTH_ATTEMPT_LIMIT,
        ttl: AUTH_ATTEMPT_WINDOW_MS,
        getTracker: signedInStaffTracker,
      },
    }),
    SkipThrottle({
      [THROTTLERS.address]: true,
      [THROTTLERS.accountAnywhere]: true,
    }),
  );
}

/**
 * `POST /auth/code`, a customer asking for a sign-in code (C6): the address
 * over every email, at the sign-in ceiling. This is only the first line,
 * so a flood is refused before any code is issued; the real caps on
 * issuance (per email and per address, counted on the code rows) are
 * `OtpService`'s.
 */
export function CodeRequestThrottle(): MethodDecorator {
  return applyDecorators(
    Throttle({
      [THROTTLERS.address]: {
        limit: SIGN_IN_ADDRESS_LIMIT,
        ttl: AUTH_ATTEMPT_WINDOW_MS,
      },
    }),
    SkipThrottle({
      [THROTTLERS.account]: true,
      [THROTTLERS.accountAnywhere]: true,
    }),
  );
}

/**
 * `POST /auth/staff/refresh`, and from C6 the customer's `POST
 * /auth/refresh`: a refused refresh signs a real person out either way.
 */
export function RefreshThrottle(): MethodDecorator {
  return applyDecorators(
    Throttle({
      [THROTTLERS.address]: {
        limit: REFRESH_ATTEMPT_LIMIT,
        ttl: AUTH_ATTEMPT_WINDOW_MS,
      },
    }),
    SkipThrottle({
      [THROTTLERS.account]: true,
      [THROTTLERS.accountAnywhere]: true,
    }),
  );
}
