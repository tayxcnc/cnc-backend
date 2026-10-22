import {
  generateOtpCode,
  maskEmail,
  OTP_CAP_WINDOW_MS,
  OTP_PATTERN,
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
  });
});
