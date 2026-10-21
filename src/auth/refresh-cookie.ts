import type { CookieOptions, Request, Response } from 'express';
import { REFRESH_TOKEN_TTL_MS } from './cnc-token.service';

/**
 * The cookie carrying a customer's refresh token (C6). Named now so the two
 * names are decided together.
 *
 * `cnc_`-prefixed (A16): TAY sets `tay_refresh_token` and
 * `tay_staff_refresh_token` with `Domain=.tayxcnc.com`, so browsers send
 * TAY's cookies to this API too. CNC reads a cookie only by its exact name,
 * so a TAY cookie is never mistaken for a CNC one, and TAY never reads CNC's
 * (host-only, so TAY's API never receives it).
 */
export const CUSTOMER_REFRESH_COOKIE = 'cnc_refresh_token';

/**
 * The cookie carrying a staff member's refresh token. A separate name from
 * the customer's, so one browser can hold both sessions without either
 * overwriting the other.
 */
export const STAFF_REFRESH_COOKIE = 'cnc_staff_refresh_token';

/** One of the two refresh cookies. Nothing else is written through here. */
export type RefreshCookieName =
  typeof CUSTOMER_REFRESH_COOKIE | typeof STAFF_REFRESH_COOKIE;

/**
 * The path the browser sends the cookie to, and nothing else: every route
 * that needs it (refresh, sign-out) is under `/api/v1/auth`, so an ordinary
 * API call carries no refresh credential. A clear must name the same path,
 * or the browser keeps the cookie.
 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * Read one cookie out of a request's `Cookie` header, by its exact name.
 *
 * There is no cookie parser in this project, so `req.cookies` is always
 * undefined; reading it instead of this function fails silently, by looking
 * like "the client sent no cookie". Copied from TAY.
 *
 * Only the named cookie is ever decoded or returned. The header also carries
 * TAY's cookies (A16), and nothing here keeps, logs or returns them.
 *
 * Values are written by `res.cookie`, which percent-encodes them. Decoding is
 * attempted and falls back to the raw text, so a malformed value reads as a
 * token that will not verify rather than a 500.
 */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  return readCookieValues(header, name)[0];
}

/**
 * Every value the `Cookie` header carries under the exact name, in header
 * order. A browser sends one pair per matching cookie, so two pairs of one
 * name are two different cookies, set with different `Domain` or `Path`
 * attributes.
 */
export function readCookieValues(
  header: string | undefined,
  name: string,
): string[] {
  if (header === undefined || header === '') {
    return [];
  }

  const values: string[] = [];

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');

    if (separator === -1) {
      continue;
    }

    if (pair.slice(0, separator).trim() !== name) {
      continue;
    }

    const value = pair.slice(separator + 1).trim();

    try {
      values.push(decodeURIComponent(value));
    } catch {
      values.push(value);
    }
  }

  return values;
}

/** What a request carries under a refresh cookie's name. */
export type PresentedRefreshCookie =
  { kind: 'absent' } | { kind: 'one'; token: string } | { kind: 'shadowed' };

/**
 * The refresh token from the named cookie, or `shadowed` when the request
 * carries the name more than once.
 *
 * CNC's cookie is host-only, but any other `tayxcnc.com` host (TAY's site
 * and API, the entrance, or a script injected into one of them) can set a
 * cookie of the same name with `Domain=.tayxcnc.com`, and the browser sends
 * both. It sends the one with the longer `Path` first, so taking the first
 * would let that host choose the token: its own valid one, and the person at
 * the till then works as somebody else's account, or junk, and they are
 * signed out on every refresh. Two of one name cannot be told apart from
 * here, so neither is spent; the caller refuses and clears them
 * (`clearShadowingRefreshCookies`).
 */
export function readRefreshCookie(
  request: Request,
  name: RefreshCookieName,
): PresentedRefreshCookie {
  const values = readCookieValues(request.headers.cookie, name);

  if (values.length === 0) return { kind: 'absent' };
  if (values.length === 1) return { kind: 'one', token: values[0] };

  return { kind: 'shadowed' };
}

/**
 * The registrable domain every CNC and TAY host shares. Used only to clear
 * a cookie another host planted at that scope; CNC never sets a cookie with
 * a `Domain` (A16).
 */
export const SHARED_PARENT_DOMAIN = 'tayxcnc.com';

/**
 * The paths a planted cookie could carry and still be sent to a refresh
 * route: every prefix of `/api/v1/auth/staff/refresh`. A browser deletes a
 * cookie only when the clear names its exact domain and path, and the path
 * a planted cookie was set with is not visible from here, so each is cleared.
 */
export const SHADOWING_COOKIE_PATHS = [
  '/',
  '/api',
  '/api/v1',
  REFRESH_COOKIE_PATH,
  `${REFRESH_COOKIE_PATH}/staff`,
  `${REFRESH_COOKIE_PATH}/staff/refresh`,
  `${REFRESH_COOKIE_PATH}/refresh`,
] as const;

/**
 * Whether a request's `Content-Type` is JSON: the CSRF check every refresh by
 * cookie must pass (A16, copied from TAY).
 *
 * `SameSite=Lax` still attaches the cookie to a same-site request, and every
 * `tayxcnc.com` host is same-site with this API. A page on any of them could
 * make the browser POST the refresh route with a form or `text/plain` (the
 * CORS-safelisted types need no preflight), spend the token, and sign the
 * person out. `application/json` forces a preflight, which fails for an
 * origin off the allowlist, so the real request is never sent. The header is
 * checked, never whether a body parsed: a `text/plain` post holding JSON
 * reaches the handler with an empty body.
 */
export function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) {
    return false;
  }

  // `application/json; charset=utf-8` is the same media type.
  return header.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * The attributes a browser matches a cookie on. They must be identical when
 * the cookie is set and when it is cleared, or the browser ignores the clear
 * and the person cannot sign out; so both writers below take them from here
 * and nowhere else.
 *
 * **Changed from TAY on purpose (A16):**
 * - **Always `SameSite=Lax`.** TAY's builder answers `None` for a host-only
 *   cookie in production, because its web app once lived on another site.
 *   Every CNC frontend, staging included, is served from a `tayxcnc.com`
 *   host, same-site with `api-cnc*.tayxcnc.com`, so `Lax` works everywhere
 *   and is never attached to a request from another site.
 * - **Host-only, always.** No `Domain` attribute, and no `CNC_COOKIE_DOMAIN`
 *   to set one: the cookie goes back to the CNC API host and nowhere else,
 *   so TAY's API never receives it.
 *
 * `Secure` follows `NODE_ENV=production`, which is every built container,
 * staging included. Local development is plain HTTP, where a `Secure` cookie
 * would never be stored.
 *
 * `maxAge` is deliberately absent: a lifetime belongs to the set only, and
 * keeping it out of the shared attributes means the clear cannot drift.
 */
export function refreshCookieAttributes(isProduction: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
  };
}

/**
 * Write a freshly issued refresh token to the cookie. `maxAge` comes from
 * the token's own lifetime, so the cookie never outlives the row it names.
 */
export function setRefreshCookie(
  response: Response,
  name: RefreshCookieName,
  token: string,
  isProduction: boolean,
): void {
  response.cookie(name, token, {
    ...refreshCookieAttributes(isProduction),
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

/**
 * Remove the cookie, with the attributes it was set with.
 *
 * Clearing it is not what signs a person out: revoking the refresh tokens at
 * the database does that, and makes a copy taken earlier useless. This only
 * stops the browser sending a value that no longer works.
 */
export function clearRefreshCookie(
  response: Response,
  name: RefreshCookieName,
  isProduction: boolean,
): void {
  response.clearCookie(name, refreshCookieAttributes(isProduction));
}

/**
 * Clear every copy of a shadowed refresh cookie (`readRefreshCookie`): CNC's
 * own host-only one, with the attributes it was set with, and a planted one
 * at `Domain=tayxcnc.com` on each path it could have been set with.
 *
 * Best effort for the planted copy: a cookie set on a path not listed here
 * survives, and the next refresh is refused again, which is still never a
 * session for the wrong account. A browser ignores the `Domain` clears on a
 * host outside `tayxcnc.com` (local development), which is harmless.
 */
export function clearShadowingRefreshCookies(
  response: Response,
  name: RefreshCookieName,
  isProduction: boolean,
): void {
  clearRefreshCookie(response, name, isProduction);

  for (const path of SHADOWING_COOKIE_PATHS) {
    response.clearCookie(name, {
      ...refreshCookieAttributes(isProduction),
      domain: SHARED_PARENT_DOMAIN,
      path,
    });
  }
}
