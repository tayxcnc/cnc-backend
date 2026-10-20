import { NAIRA, formatKobo, koboToNairaDecimal } from './money';

/**
 * Formatting money for display.
 *
 * Every sentence the server writes about an amount — a confirmation email, an
 * audit description — must contain ₦ and the formatted figure, and never the
 * raw integer. That is really a test of this function, and it belongs here as
 * well as end to end, because this is where the mistake would be made and the
 * screen is only where it would be noticed.
 */
describe('formatKobo', () => {
  it('divides by a hundred and groups thousands', () => {
    expect(formatKobo(4_000_000)).toBe('₦40,000.00');
    expect(formatKobo(1_500_000)).toBe('₦15,000.00');
    expect(formatKobo(6_500_000)).toBe('₦65,000.00');
  });

  /**
   * The bug this function exists to prevent, stated as a test: the stored
   * integer must never appear in the output. `4000000` rendered as-is is a
   * price a hundred times too high on something a customer keeps.
   */
  it('never renders the raw kobo integer', () => {
    for (const kobo of [4_000_000, 1_500_000, 250_000, 100]) {
      expect(formatKobo(kobo)).not.toContain(String(kobo));
    }
  });

  it('always shows two decimal places', () => {
    expect(formatKobo(100)).toBe('₦1.00');
    expect(formatKobo(150)).toBe('₦1.50');
    expect(formatKobo(1)).toBe('₦0.01');
    expect(formatKobo(0)).toBe('₦0.00');
  });

  it('does not group below a thousand', () => {
    expect(formatKobo(99_900)).toBe('₦999.00');
  });

  /**
   * The symbol is prepended rather than produced by `Intl`'s NGN currency
   * formatting, because that output differs by ICU build. This asserts the
   * character itself.
   */
  it('uses the naira sign, not a currency code', () => {
    const formatted = formatKobo(4_000_000);

    expect(formatted.startsWith(NAIRA)).toBe(true);
    expect(formatted).not.toContain('NGN');
    expect(NAIRA).toBe('₦');
  });

  it('puts the minus outside the symbol', () => {
    expect(formatKobo(-50_000)).toBe('-₦500.00');
  });

  /**
   * Loud rather than rounded. A fractional kobo means an integer column has
   * been read as something else upstream, and a plausible-looking rounded
   * figure would bury that.
   */
  it('refuses a non-integer rather than rounding it', () => {
    expect(() => formatKobo(100.5)).toThrow(/integer kobo/);
    expect(() => formatKobo(Number.NaN)).toThrow(/integer kobo/);
  });
});

/**
 * Money for a spreadsheet cell: naira, two decimals, nothing a spreadsheet
 * would read as text.
 */
describe('koboToNairaDecimal', () => {
  it('writes naira with two decimals and no sign or grouping', () => {
    expect(koboToNairaDecimal(400_000)).toBe('4000.00');
    expect(koboToNairaDecimal(123_456_700)).toBe('1234567.00');
    expect(koboToNairaDecimal(0)).toBe('0.00');
  });

  it('keeps the kobo of a value that is not whole naira', () => {
    expect(koboToNairaDecimal(400_050)).toBe('4000.50');
    expect(koboToNairaDecimal(5)).toBe('0.05');
    expect(koboToNairaDecimal(99)).toBe('0.99');
  });

  it('keeps the minus of a negative, which is a gap', () => {
    expect(koboToNairaDecimal(-50_000)).toBe('-500.00');
    expect(koboToNairaDecimal(-5)).toBe('-0.05');
  });

  it('refuses a non-integer rather than rounding it', () => {
    expect(() => koboToNairaDecimal(100.5)).toThrow(/integer kobo/);
    expect(() => koboToNairaDecimal(Number.NaN)).toThrow(/integer kobo/);
  });
});
