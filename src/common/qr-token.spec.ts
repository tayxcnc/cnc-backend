import { generateQrToken } from './qr-token';

describe('generateQrToken', () => {
  it('is 32 random bytes in base64url: 43 characters, no padding', () => {
    const token = generateQrToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 100 }, generateQrToken));

    expect(tokens.size).toBe(100);
  });
});
