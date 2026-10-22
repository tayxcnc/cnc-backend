import { createHash } from 'node:crypto';
import { deriveKey } from '../common/derived-key';
import {
  generateOtpCode,
  maskEmail,
  OTP_CAP_WINDOW_MS,
  OTP_DAILY_WINDOW_MS,
  OTP_HASH_KEY_INFO,
  OTP_PATTERN,
  otpCodeHash,
} from './one-time-code';
import { OTP_RETENTION_HOURS } from '../internal/tokens-sweep.service';

describe('one-time codes', () => {
  it('draws six digits, zero-padded', () => {
    for (let draw = 0; draw < 500; draw++) {
      expect(generateOtpCode()).toMatch(OTP_PATTERN);
    }
  });

  it('masks an email as the account app does', () => {
    expect(maskEmail('ada@example.com')).toBe('a•••@example.com');
  });

  it('counts its caps inside the rows the tokens sweep keeps', () => {
    // The caps count stored rows; a window longer than their retention
    // would let a caller reset the count by waiting for the sweep.
    expect(OTP_CAP_WINDOW_MS).toBeLessThanOrEqual(
      OTP_RETENTION_HOURS * 60 * 60 * 1000,
    );
    expect(OTP_DAILY_WINDOW_MS).toBeLessThanOrEqual(
      OTP_RETENTION_HOURS * 60 * 60 * 1000,
    );
  });

  it('keeps a keyed digest: not the bare SHA-256, and another key gives another', () => {
    const key = deriveKey('a'.repeat(32), OTP_HASH_KEY_INFO);
    const other = deriveKey('b'.repeat(32), OTP_HASH_KEY_INFO);

    expect(otpCodeHash(key, '123456')).toMatch(/^[0-9a-f]{64}$/);
    expect(otpCodeHash(key, '123456')).toBe(otpCodeHash(key, '123456'));
    expect(otpCodeHash(key, '123456')).not.toBe(
      createHash('sha256').update('123456').digest('hex'),
    );
    expect(otpCodeHash(key, '123456')).not.toBe(otpCodeHash(other, '123456'));
  });
});
