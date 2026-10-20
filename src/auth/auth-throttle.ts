/**
 * Rate limits for the staff credential routes, copied from TAY's
 * `auth-throttle.ts` (plan §11: ten per fifteen minutes; refresh thirty).
 *
 * Counted per client address (`clientAddressOf`) and per route, in memory in
 * each instance (plan A18: no Redis at launch). Two instances at most means a
 * caller gets at most twice the number below, which is still a number and
 * not "unlimited".
 *
 * Applied per route with `@UseGuards(ClientAddressThrottlerGuard)` and
 * `@Throttle`, never as an APP_GUARD: a global guard would put every read in
 * the staff app under the sign-in limit, silently, as a side effect of
 * protecting sign-in.
 */

/**
 * Attempts per window, per client address, on sign-in, change-password and
 * the admin password reset. Generous enough for a person mistyping three
 * times; tight enough that a credential-stuffing run from one address gets
 * ten guesses, not ten thousand.
 */
export const AUTH_ATTEMPT_LIMIT = 10;

/** The window, in milliseconds. Fifteen minutes. */
export const AUTH_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Refreshes per window, per client address. A refused refresh signs a real
 * person out, so this is three times the credential limit: a till with
 * several tabs, or a tablet waking from sleep, refreshes a handful of times
 * in a minute. It still turns an unauthenticated, state-changing route from
 * unlimited into a number (TAY's Phase 4 brief §6.2).
 */
export const REFRESH_ATTEMPT_LIMIT = 30;

/**
 * The refusal every throttled route answers with (429). A fixed sentence,
 * because the screens show a refusal's message verbatim; the throttler's own
 * default ("ThrottlerException: Too Many Requests") names a class.
 */
export const TOO_MANY_ATTEMPTS_MESSAGE =
  'Too many attempts. Wait a few minutes and try again.';
