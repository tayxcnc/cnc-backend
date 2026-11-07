import {
  MONTH_MESSAGE,
  PERIOD_DATES_MESSAGE,
  PERIOD_LENGTH_MESSAGE,
  PERIOD_ORDER_MESSAGE,
} from './attendance-messages';
import {
  attendanceSummary,
  CHECK_OUT_AFTER_MS,
  monthPeriod,
  overlaps,
  parseStaffCode,
  parseWatWallClock,
  periodFor,
  REPEAT_SCAN_WINDOW_MS,
  scanStep,
  shiftHours,
  tokensMatch,
  validatePeriod,
} from './attendance-rules';

const at = (iso: string) => new Date(iso);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const ymd = (date: Date) => date.toISOString().slice(0, 10);

describe('parseStaffCode', () => {
  it('reads the staff number and token of a CNC staff ID, trimmed as a scanner sends it', () => {
    expect(parseStaffCode('CNC-ID:CNC-S004:abc_DEF-123\r\n')).toEqual({
      staffNo: 'CNC-S004',
      token: 'abc_DEF-123',
    });
  });

  it('refuses anything that is not exactly a CNC staff ID', () => {
    for (const code of [
      'CNC-ID:bad',
      'CNC-ID::token',
      'CNC-ID:CNC-S004:',
      'CNC-ID:CNC-S004:a:b',
      'TAY-ID:T-001:token',
      `CNC-ID:CNC-S004:${'x'.repeat(300)}`,
      '',
      42,
      null,
    ]) {
      expect(parseStaffCode(code)).toBeNull();
    }
  });
});

describe('tokensMatch', () => {
  it('matches only the same token, whatever the lengths', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', 'abcd')).toBe(false);
    expect(tokensMatch('abc', '')).toBe(false);
  });
});

describe('scanStep', () => {
  const now = at('2026-10-02T12:00:00Z');

  it('checks in a person with no shift, and one whose last shift is closed', () => {
    expect(scanStep(null, null, now)).toBe('CHECK_IN');
    expect(
      scanStep(
        {
          timeIn: at('2026-10-02T07:00:00Z'),
          timeOut: at('2026-10-02T11:00:00Z'),
        },
        null,
        now,
      ),
    ).toBe('CHECK_IN');
  });

  it('checks out an open shift, an overnight one included', () => {
    const overnight = { timeIn: at('2026-10-01T21:30:00Z'), timeOut: null };

    expect(scanStep(overnight, overnight, now)).toBe('CHECK_OUT');
  });

  it('ignores a scan within an hour of the arrival, and checks out from the hour', () => {
    const justArrived = { timeIn: at('2026-10-02T11:59:30Z'), timeOut: null };
    const almostAnHour = {
      timeIn: new Date(now.getTime() - CHECK_OUT_AFTER_MS + 1),
      timeOut: null,
    };
    const anHour = {
      timeIn: new Date(now.getTime() - CHECK_OUT_AFTER_MS),
      timeOut: null,
    };

    expect(scanStep(justArrived, justArrived, now)).toBe('REPEAT');
    expect(scanStep(almostAnHour, almostAnHour, now)).toBe('REPEAT');
    expect(scanStep(anHour, anHour, now)).toBe('CHECK_OUT');
  });

  it('ignores a repeat within a minute of the departure, and checks in after it', () => {
    const left = {
      timeIn: at('2026-10-02T08:00:00Z'),
      timeOut: new Date(now.getTime() - REPEAT_SCAN_WINDOW_MS + 1),
    };
    const leftAMinuteAgo = {
      timeIn: at('2026-10-02T08:00:00Z'),
      timeOut: new Date(now.getTime() - REPEAT_SCAN_WINDOW_MS),
    };

    expect(scanStep(left, null, now)).toBe('REPEAT');
    expect(scanStep(leftAMinuteAgo, null, now)).toBe('CHECK_IN');
  });
});

describe('parseWatWallClock', () => {
  it('reads a Lagos wall clock as its UTC instant', () => {
    expect(parseWatWallClock('2026-10-02T07:30')?.toISOString()).toBe(
      '2026-10-02T06:30:00.000Z',
    );
    expect(parseWatWallClock('2026-10-03T00:30')?.toISOString()).toBe(
      '2026-10-02T23:30:00.000Z',
    );
  });

  it('refuses anything else', () => {
    for (const value of [
      '2026-02-30T07:30',
      '2026-10-02T24:00',
      '2026-10-02 07:30',
      '2026-10-02T07:30:00Z',
      '',
      null,
      123,
    ]) {
      expect(parseWatWallClock(value)).toBeNull();
    }
  });
});

describe('overlaps', () => {
  const now = at('2026-10-02T12:00:00Z');
  const shift = {
    timeIn: at('2026-10-02T07:00:00Z'),
    timeOut: at('2026-10-02T08:00:00Z'),
  };

  it('finds shifts that each start before the other ends, an open one running until now', () => {
    expect(
      overlaps(
        {
          timeIn: at('2026-10-02T07:30:00Z'),
          timeOut: at('2026-10-02T09:00:00Z'),
        },
        shift,
        now,
      ),
    ).toBe(true);
    expect(
      overlaps(
        { timeIn: at('2026-10-02T09:00:00Z'), timeOut: null },
        { timeIn: at('2026-10-02T10:00:00Z'), timeOut: null },
        now,
      ),
    ).toBe(true);
  });

  it('lets shifts that only touch stand side by side', () => {
    expect(
      overlaps(
        {
          timeIn: at('2026-10-02T08:00:00Z'),
          timeOut: at('2026-10-02T09:00:00Z'),
        },
        shift,
        now,
      ),
    ).toBe(false);
  });
});

describe('periods', () => {
  it('date ranges reject invalid or reversed dates and month boundaries include leap years (attendance.test.cjs)', () => {
    expect(() => validatePeriod('2026-02-30', '2026-03-01')).toThrow(
      PERIOD_DATES_MESSAGE,
    );
    expect(() => validatePeriod('', '2026-03-01')).toThrow(
      PERIOD_DATES_MESSAGE,
    );
    expect(() => validatePeriod('2026-10-02', '2026-10-01')).toThrow(
      PERIOD_ORDER_MESSAGE,
    );
    expect(() => validatePeriod('2026-10-02', '2026-10-02')).not.toThrow();

    const february = monthPeriod('2024-02');
    const december = monthPeriod('2026-12');

    expect([ymd(february.from), ymd(february.to)]).toEqual([
      '2024-02-01',
      '2024-02-29',
    ]);
    expect([ymd(december.from), ymd(december.to)]).toEqual([
      '2026-12-01',
      '2026-12-31',
    ]);
    expect(() => monthPeriod('2026-13')).toThrow(MONTH_MESSAGE);
  });

  it('refuses a period over a year', () => {
    expect(() => validatePeriod('2026-01-01', '2027-01-02')).toThrow(
      PERIOD_LENGTH_MESSAGE,
    );
    expect(() => validatePeriod('2026-01-01', '2027-01-01')).not.toThrow();
  });

  it('defaults to this month in Lagos, which can be ahead of UTC', () => {
    const range = periodFor({}, at('2026-09-30T23:30:00Z'));

    expect([ymd(range.from), ymd(range.to)]).toEqual([
      '2026-10-01',
      '2026-10-31',
    ]);
  });

  it('prefers a range to a month', () => {
    const range = periodFor(
      { month: '2026-01', from: '2026-10-02', to: '2026-10-03' },
      at('2026-10-05T12:00:00Z'),
    );

    expect([ymd(range.from), ymd(range.to)]).toEqual([
      '2026-10-02',
      '2026-10-03',
    ]);
  });
});

describe('attendanceSummary', () => {
  it('payroll summary counts arrival days once and never estimates hours for open shifts (attendance.test.cjs)', () => {
    expect(
      attendanceSummary([
        {
          businessDate: day('2026-10-02'),
          timeIn: at('2026-10-02T07:00:00Z'),
          timeOut: at('2026-10-02T11:00:00Z'),
          corrections: 0,
        },
        {
          businessDate: day('2026-10-02'),
          timeIn: at('2026-10-02T12:00:00Z'),
          timeOut: at('2026-10-02T13:30:00Z'),
          corrections: 1,
        },
        {
          businessDate: day('2026-10-03'),
          timeIn: at('2026-10-03T07:00:00Z'),
          timeOut: null,
          corrections: 0,
        },
      ]),
    ).toEqual({
      days: 2,
      shifts: 3,
      completed: 2,
      open: 1,
      hours: 5.5,
      corrections: 1,
    });
  });

  it('gives an open shift no hours', () => {
    expect(
      shiftHours({ timeIn: at('2026-10-02T07:00:00Z'), timeOut: null }),
    ).toBe(0);
  });
});
