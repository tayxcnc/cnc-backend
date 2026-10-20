import { formatWatClock, formatWatLongDate } from './wat-format';

describe('formatWatLongDate', () => {
  it('writes the Nigerian date, day first and the month in words', () => {
    expect(formatWatLongDate(new Date('2026-09-06T10:00:00.000Z'))).toBe(
      '6 September 2026',
    );
  });

  it('moves to the next day at 23:00 UTC, which is midnight in Nigeria', () => {
    expect(formatWatLongDate(new Date('2026-12-31T22:59:00.000Z'))).toBe(
      '31 December 2026',
    );
    expect(formatWatLongDate(new Date('2026-12-31T23:00:00.000Z'))).toBe(
      '1 January 2027',
    );
  });
});

describe('formatWatClock', () => {
  it('writes the Nigerian wall clock, zero-padded', () => {
    expect(formatWatClock(new Date('2026-09-06T17:30:00.000Z'))).toBe('18:30');
    expect(formatWatClock(new Date('2026-09-06T23:05:00.000Z'))).toBe('00:05');
  });
});
