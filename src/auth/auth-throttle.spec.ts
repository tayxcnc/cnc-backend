import {
  signedInStaffTracker,
  signInAnywhereTracker,
  signInAtAddressTracker,
} from './auth-throttle';
import { STAFF_PRINCIPAL_KEY } from './staff-principal';

/** A request as the throttler sees it: from one venue address. */
function from(body: unknown, extra: Record<string, unknown> = {}) {
  return {
    headers: { 'x-forwarded-for': '203.0.113.7, 10.255.255.1' },
    body,
    ...extra,
  };
}

describe('auth throttle trackers', () => {
  describe('sign-in', () => {
    it('counts the email at the address, as the DTO normalises it', () => {
      expect(signInAtAddressTracker(from({ email: ' Ada@CNC.example ' }))).toBe(
        '203.0.113.7|ada@cnc.example',
      );
    });

    it('gives two people at one address two counts', () => {
      expect(signInAtAddressTracker(from({ email: 'a@cnc.example' }))).not.toBe(
        signInAtAddressTracker(from({ email: 'b@cnc.example' })),
      );
    });

    it('counts the email alone across addresses', () => {
      expect(signInAnywhereTracker(from({ email: 'Ada@cnc.example' }))).toBe(
        'ada@cnc.example',
      );
    });

    it('puts a body without a string email under one empty key', () => {
      for (const body of [undefined, null, 'text', { email: 7 }, {}]) {
        expect(signInAnywhereTracker(from(body))).toBe('');
        expect(signInAtAddressTracker(from(body))).toBe('203.0.113.7|');
      }
    });
  });

  describe('signed-in routes', () => {
    it('counts the account the staff guard verified, not the address', () => {
      const request = from(
        {},
        {
          [STAFF_PRINCIPAL_KEY]: {
            id: 'staff-1',
            staffNo: 'CNC-S001',
            name: 'Ada',
            role: 'MANAGER',
          },
        },
      );

      expect(signedInStaffTracker(request)).toBe('staff-1');
    });

    it('refuses to count before the staff guard has run', () => {
      expect(() => signedInStaffTracker(from({}))).toThrow(
        /ran before CncStaffGuard/,
      );
    });
  });
});
