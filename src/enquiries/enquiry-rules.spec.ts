import { createHash } from 'node:crypto';
import { hashClientAddress } from '../common/client-address';
import { idempotencyScope } from '../idempotency/idempotency-scope';
import {
  ENQUIRY_ADDRESS_LIMIT,
  ENQUIRY_REQUEST_LIMIT,
  isHoneypotFilled,
} from './enquiry-rules';

describe('enquiry rules', () => {
  it('reads anything but an absent, null or blank honeypot as a bot', () => {
    for (const value of [undefined, null, '', '   ']) {
      expect(isHoneypotFilled(value)).toBe(false);
    }

    for (const value of ['Acme', 0, false, [], {}, ['x']]) {
      expect(isHoneypotFilled(value)).toBe(true);
    }
  });

  it('counts the stored cap inside the request throttle', () => {
    expect(ENQUIRY_ADDRESS_LIMIT).toBeLessThan(ENQUIRY_REQUEST_LIMIT);
  });

  it('hashes an address one way for every table that keeps it', () => {
    const digest = createHash('sha256').update('203.0.113.9').digest('hex');

    expect(hashClientAddress('203.0.113.9')).toBe(digest);
    expect(idempotencyScope.anonymous('203.0.113.9')).toBe(`anon:${digest}`);
  });
});
