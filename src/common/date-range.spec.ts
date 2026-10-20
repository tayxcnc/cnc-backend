import { BadRequestException } from '@nestjs/common';
import { formatIsoDate } from './calendar-date';
import { resolveDateRange } from './date-range';

describe('resolveDateRange', () => {
  // 23:30 UTC on the 11th is 00:30 on the 12th in Nigeria.
  const now = new Date('2026-10-11T23:30:00.000Z');
  const rules = { defaultDays: 7, maxDays: 366, subject: 'Sales' };

  const read = (query: { from?: string; to?: string }, over = rules) => {
    const { from, to } = resolveDateRange(query, now, over);

    return [formatIsoDate(from), formatIsoDate(to)];
  };

  const refusal = (query: { from?: string; to?: string }, over = rules) => {
    try {
      resolveDateRange(query, now, over);
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);

      return (error as BadRequestException).message;
    }

    throw new Error('The range was not refused.');
  };

  it('defaults `to` to today in Nigeria, and `from` to the days ending on it', () => {
    expect(read({})).toEqual(['2026-10-06', '2026-10-12']);
    expect(read({}, { ...rules, defaultDays: 1 })).toEqual([
      '2026-10-12',
      '2026-10-12',
    ]);
    expect(read({}, { ...rules, defaultDays: 30 })).toEqual([
      '2026-09-13',
      '2026-10-12',
    ]);
  });

  it('counts the default back from a `to` that was given', () => {
    expect(read({ to: '2026-03-10' })).toEqual(['2026-03-04', '2026-03-10']);
  });

  it('takes both ends as given, inclusive, a single day included', () => {
    expect(read({ from: '2026-01-01', to: '2026-01-31' })).toEqual([
      '2026-01-01',
      '2026-01-31',
    ]);
    expect(read({ from: '2026-01-05', to: '2026-01-05' })).toEqual([
      '2026-01-05',
      '2026-01-05',
    ]);
  });

  it('refuses an impossible date, naming the end', () => {
    expect(refusal({ to: '2026-02-30' })).toBe(
      'to must be a real calendar date.',
    );
    expect(refusal({ from: '2026-13-01', to: '2026-12-01' })).toBe(
      'from must be a real calendar date.',
    );
    expect(refusal({ from: 'yesterday' })).toBe(
      'from must be a real calendar date.',
    );
  });

  it('refuses `to` before `from`', () => {
    expect(refusal({ from: '2026-10-12', to: '2026-10-11' })).toBe(
      'to must not be before from.',
    );
    // `from` alone, after today.
    expect(refusal({ from: '2026-10-13' })).toBe('to must not be before from.');
  });

  it('allows the cap exactly and refuses a day over, with the subject', () => {
    expect(read({ from: '2025-10-12', to: '2026-10-12' })).toEqual([
      '2025-10-12',
      '2026-10-12',
    ]);
    expect(refusal({ from: '2025-10-11', to: '2026-10-12' })).toBe(
      'Sales covers at most 366 days at a time; ' +
        '2025-10-11 to 2026-10-12 is 367.',
    );
    expect(
      refusal(
        { from: '2026-10-01', to: '2026-10-12' },
        { defaultDays: 1, maxDays: 10, subject: 'A waste report' },
      ),
    ).toBe(
      'A waste report covers at most 10 days at a time; ' +
        '2026-10-01 to 2026-10-12 is 12.',
    );
  });
});
