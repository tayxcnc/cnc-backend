import type { CookieOptions, Request, Response } from 'express';
import { REFRESH_TOKEN_TTL_MS } from './cnc-token.service';
import {
  clearRefreshCookie,
  clearShadowingRefreshCookies,
  CUSTOMER_REFRESH_COOKIE,
  isJsonContentType,
  readCookie,
  readCookieValues,
  readRefreshCookie,
  REFRESH_COOKIE_PATH,
  refreshCookieAttributes,
  setRefreshCookie,
  SHADOWING_COOKIE_PATHS,
  SHARED_PARENT_DOMAIN,
  STAFF_REFRESH_COOKIE,
} from './refresh-cookie';

/** A Response that records the two cookie calls and nothing else. */
function recordingResponse() {
  const calls: {
    set?: { name: string; value: string; options: CookieOptions };
    clear?: { name: string; options: CookieOptions };
  } = {};

  const response = {
    cookie: (name: string, value: string, options: CookieOptions) => {
      calls.set = { name, value, options };
    },
    clearCookie: (name: string, options: CookieOptions) => {
      calls.clear = { name, options };
    },
  } as unknown as Response;

  return { response, calls };
}

describe('refresh cookie', () => {
  it('names both cookies with the cnc_ prefix, never TAY’s names', () => {
    expect(STAFF_REFRESH_COOKIE).toBe('cnc_staff_refresh_token');
    expect(CUSTOMER_REFRESH_COOKIE).toBe('cnc_refresh_token');
  });

  describe('readCookie', () => {
    it('reads the named cookie only, by its exact name', () => {
      const header =
        'tay_staff_refresh_token=tay-staff; tay_refresh_token=tay-member; ' +
        'cnc_staff_refresh_token=cnc-staff';

      expect(readCookie(header, STAFF_REFRESH_COOKIE)).toBe('cnc-staff');
      expect(readCookie(header, CUSTOMER_REFRESH_COOKIE)).toBeUndefined();
    });

    it('never takes a TAY cookie for a CNC one, whatever the order', () => {
      expect(
        readCookie(
          'tay_staff_refresh_token=x; tay_refresh_token=y',
          STAFF_REFRESH_COOKIE,
        ),
      ).toBeUndefined();
    });

    it('decodes a percent-encoded value and keeps a malformed one raw', () => {
      expect(readCookie('a=b%2Fc', 'a')).toBe('b/c');
      expect(readCookie('a=%E0%A4%A', 'a')).toBe('%E0%A4%A');
    });

    it('answers undefined for no header, an empty one, or pairs without "="', () => {
      expect(readCookie(undefined, 'a')).toBeUndefined();
      expect(readCookie('', 'a')).toBeUndefined();
      expect(readCookie('a; b', 'a')).toBeUndefined();
    });
  });

  describe('readRefreshCookie', () => {
    const presented = (cookie: string | undefined) =>
      readRefreshCookie(
        { headers: { cookie } } as unknown as Request,
        STAFF_REFRESH_COOKIE,
      );

    it('answers absent, or the one token', () => {
      expect(presented(undefined)).toEqual({ kind: 'absent' });
      expect(presented('tay_staff_refresh_token=x')).toEqual({
        kind: 'absent',
      });
      expect(presented('cnc_staff_refresh_token=mine; tay_x=y')).toEqual({
        kind: 'one',
        token: 'mine',
      });
    });

    it('answers shadowed, with no token, when the name comes twice', () => {
      // What a browser sends when another tayxcnc.com host planted a cookie
      // of this name at Domain=.tayxcnc.com with a longer path: the planted
      // one first.
      const header =
        'cnc_staff_refresh_token=planted; cnc_staff_refresh_token=mine';

      expect(presented(header)).toEqual({ kind: 'shadowed' });
      expect(readCookieValues(header, STAFF_REFRESH_COOKIE)).toEqual([
        'planted',
        'mine',
      ]);
    });
  });

  describe('clearShadowingRefreshCookies', () => {
    it('clears the host-only cookie and a planted one on every path a refresh is sent to', () => {
      const clears: CookieOptions[] = [];
      const response = {
        clearCookie: (name: string, options: CookieOptions) => {
          expect(name).toBe(STAFF_REFRESH_COOKIE);
          clears.push(options);
        },
      } as unknown as Response;

      clearShadowingRefreshCookies(response, STAFF_REFRESH_COOKIE, true);

      // CNC's own, exactly as clearRefreshCookie clears it.
      expect(clears[0]).toEqual(refreshCookieAttributes(true));

      const planted = clears.slice(1);
      expect(planted.every((o) => o.domain === SHARED_PARENT_DOMAIN)).toBe(
        true,
      );
      expect(planted.map((o) => o.path)).toEqual([...SHADOWING_COOKIE_PATHS]);

      // Every path listed is a prefix of a refresh route, so a cookie set
      // there is one the browser sends to it.
      for (const path of SHADOWING_COOKIE_PATHS) {
        expect(
          ['/api/v1/auth/staff/refresh', '/api/v1/auth/refresh'].some(
            (route) =>
              path === '/' || route === path || route.startsWith(`${path}/`),
          ),
        ).toBe(true);
      }
    });
  });

  describe('isJsonContentType', () => {
    it.each([
      ['application/json', true],
      ['application/json; charset=utf-8', true],
      ['Application/JSON', true],
      ['text/plain', false],
      ['application/x-www-form-urlencoded', false],
      ['multipart/form-data; boundary=x', false],
      [undefined, false],
    ])('%s → %s', (header, expected) => {
      expect(isJsonContentType(header)).toBe(expected);
    });
  });

  describe('set and clear', () => {
    it.each([true, false])(
      'are host-only, SameSite=Lax, httpOnly, on /api/v1/auth (production %s)',
      (isProduction) => {
        const { response, calls } = recordingResponse();

        setRefreshCookie(response, STAFF_REFRESH_COOKIE, 'tok', isProduction);

        expect(calls.set).toEqual({
          name: STAFF_REFRESH_COOKIE,
          value: 'tok',
          options: {
            httpOnly: true,
            secure: isProduction,
            sameSite: 'lax',
            path: REFRESH_COOKIE_PATH,
            maxAge: REFRESH_TOKEN_TTL_MS,
          },
        });
        expect(calls.set?.options).not.toHaveProperty('domain');
      },
    );

    it('clears with exactly the attributes it set, less the lifetime', () => {
      for (const isProduction of [true, false]) {
        const { response, calls } = recordingResponse();

        setRefreshCookie(response, STAFF_REFRESH_COOKIE, 'tok', isProduction);
        clearRefreshCookie(response, STAFF_REFRESH_COOKIE, isProduction);

        const { maxAge, ...matched } = calls.set!.options;
        expect(maxAge).toBe(REFRESH_TOKEN_TTL_MS);
        expect(calls.clear).toEqual({
          name: STAFF_REFRESH_COOKIE,
          options: matched,
        });
      }
    });
  });
});
