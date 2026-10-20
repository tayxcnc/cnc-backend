import { UNKNOWN_ADDRESS, clientAddressOf } from './client-address';

describe('clientAddressOf', () => {
  it('takes the second-from-last hop of a proxy chain', () => {
    expect(
      clientAddressOf({
        headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.1' },
        ip: '10.0.0.1',
      }),
    ).toBe('198.51.100.7');
  });

  it('ignores a hop the client prepended itself', () => {
    expect(
      clientAddressOf({
        headers: {
          'x-forwarded-for': '192.0.2.99, 198.51.100.7, 203.0.113.1',
        },
      }),
    ).toBe('198.51.100.7');
  });

  it('uses the only hop when there is just one', () => {
    expect(
      clientAddressOf({ headers: { 'x-forwarded-for': '198.51.100.7' } }),
    ).toBe('198.51.100.7');
  });

  it('joins a repeated header back into wire order', () => {
    expect(
      clientAddressOf({
        headers: { 'x-forwarded-for': ['198.51.100.7', '203.0.113.1'] },
      }),
    ).toBe('198.51.100.7');
  });

  it('tolerates whitespace and empty entries', () => {
    expect(
      clientAddressOf({
        headers: { 'x-forwarded-for': ' 198.51.100.7 , , 203.0.113.1 ' },
      }),
    ).toBe('198.51.100.7');
  });

  it('falls back to req.ip with no header', () => {
    expect(clientAddressOf({ headers: {}, ip: '::ffff:127.0.0.1' })).toBe(
      '::ffff:127.0.0.1',
    );
  });

  it('falls back to req.ip when the header is blank', () => {
    expect(
      clientAddressOf({ headers: { 'x-forwarded-for': '   ' }, ip: '::1' }),
    ).toBe('::1');
  });

  it('shares one bucket for everything unidentifiable', () => {
    expect(clientAddressOf({})).toBe(UNKNOWN_ADDRESS);
    expect(clientAddressOf({ headers: null, ip: '' })).toBe(UNKNOWN_ADDRESS);
    expect(clientAddressOf({ ip: 42 })).toBe(UNKNOWN_ADDRESS);
  });
});
