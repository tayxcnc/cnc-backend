import {
  addDays,
  daysBetween,
  formatIsoDate,
  parseIsoDate,
} from './calendar-date';

/**
 * Calendar-date arithmetic, at the boundaries.
 *
 * The middle of a month is not where date code goes wrong. These cover the
 * places it does: a month end, a leap day, a date that does not exist, and the
 * timestamp-shaped input the parser exists to refuse.
 */
describe('calendar dates', () => {
  describe('parseIsoDate', () => {
    it('reads a plain calendar date as UTC midnight', () => {
      expect(parseIsoDate('2026-09-14')?.toISOString()).toBe(
        '2026-09-14T00:00:00.000Z',
      );
    });

    it('refuses anything carrying a time or a zone', () => {
      // The reason @IsDateString is not used anywhere near these columns:
      // this names the fifteenth in Nigeria while reading as the fourteenth.
      expect(parseIsoDate('2026-09-14T23:30:00-05:00')).toBeNull();
      expect(parseIsoDate('2026-09-14T00:00:00.000Z')).toBeNull();
    });

    it('refuses a date that does not exist', () => {
      // Date.UTC rolls 2026-02-30 into March rather than failing, which is
      // why the fields are compared back.
      expect(parseIsoDate('2026-02-30')).toBeNull();
      expect(parseIsoDate('2026-13-01')).toBeNull();
      expect(parseIsoDate('2026-00-10')).toBeNull();
    });

    it('accepts a leap day in a leap year and refuses it otherwise', () => {
      expect(parseIsoDate('2028-02-29')).not.toBeNull();
      expect(parseIsoDate('2026-02-29')).toBeNull();
    });

    it('refuses shapes that are not YYYY-MM-DD', () => {
      expect(parseIsoDate('2026-9-14')).toBeNull();
      expect(parseIsoDate('14/09/2026')).toBeNull();
      expect(parseIsoDate('')).toBeNull();
    });
  });

  describe('formatIsoDate', () => {
    it('round-trips with parseIsoDate', () => {
      const parsed = parseIsoDate('2026-09-14');

      expect(parsed).not.toBeNull();
      expect(formatIsoDate(parsed as Date)).toBe('2026-09-14');
    });
  });

  describe('addDays', () => {
    it('adds calendar days across a month end', () => {
      const from = parseIsoDate('2026-09-30') as Date;

      expect(formatIsoDate(addDays(from, 1))).toBe('2026-10-01');
    });

    it('adds calendar days across a leap day', () => {
      const from = parseIsoDate('2028-02-28') as Date;

      expect(formatIsoDate(addDays(from, 1))).toBe('2028-02-29');
      expect(formatIsoDate(addDays(from, 2))).toBe('2028-03-01');
    });

    it('goes backwards too', () => {
      const from = parseIsoDate('2026-10-01') as Date;

      expect(formatIsoDate(addDays(from, -1))).toBe('2026-09-30');
    });
  });

  describe('daysBetween', () => {
    it('counts whole days, inclusive of neither end', () => {
      const from = parseIsoDate('2026-09-14') as Date;
      const to = parseIsoDate('2026-09-28') as Date;

      expect(daysBetween(from, to)).toBe(14);
      expect(daysBetween(to, from)).toBe(-14);
      expect(daysBetween(from, from)).toBe(0);
    });

    it('is unaffected by a month boundary', () => {
      const from = parseIsoDate('2026-09-30') as Date;
      const to = parseIsoDate('2026-10-01') as Date;

      expect(daysBetween(from, to)).toBe(1);
    });
  });
});
