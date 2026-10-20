import {
  watCalendarFields,
  watInstantAt,
  watSessionEnd,
  watToday,
  watWallClockToUtc,
} from './wat';

/**
 * West Africa Time at the boundaries that matter: midnight in Nigeria, which
 * is 23:00 UTC the day before, and a span that ends after midnight.
 */
describe('WAT', () => {
  const date = new Date('2026-10-20T00:00:00.000Z');

  it('turns a Nigerian wall clock into the UTC instant an hour earlier', () => {
    expect(watWallClockToUtc(2026, 9, 20, 20, 0).toISOString()).toBe(
      '2026-10-20T19:00:00.000Z',
    );
    expect(watWallClockToUtc(2026, 9, 20).toISOString()).toBe(
      '2026-10-19T23:00:00.000Z',
    );
  });

  it('reads an "HH:mm" time on a @db.Date value', () => {
    expect(watInstantAt(date, '20:30').toISOString()).toBe(
      '2026-10-20T19:30:00.000Z',
    );
  });

  it('refuses a time that is not zero-padded 24-hour "HH:mm"', () => {
    for (const time of ['8:00', '24:00', '20:60', '20:30:00', '']) {
      expect(() => watInstantAt(date, time)).toThrow(/HH:mm/);
    }
  });

  it('ends a span that crosses midnight on the next morning', () => {
    expect(watSessionEnd(date, '18:00', '01:00').toISOString()).toBe(
      '2026-10-21T00:00:00.000Z',
    );
    expect(watSessionEnd(date, '22:30', '00:00').toISOString()).toBe(
      '2026-10-20T23:00:00.000Z',
    );
  });

  it('leaves a span that ends the same day unchanged', () => {
    expect(watSessionEnd(date, '12:00', '15:00').toISOString()).toBe(
      watInstantAt(date, '15:00').toISOString(),
    );
  });

  it('validates the start time as well as the end', () => {
    expect(() => watSessionEnd(date, '7:00', '15:00')).toThrow(/HH:mm/);
  });

  it('moves to the next day at 23:00 UTC, which is midnight in Nigeria', () => {
    expect(watToday(new Date('2026-10-20T22:59:00.000Z')).toISOString()).toBe(
      '2026-10-20T00:00:00.000Z',
    );
    expect(watToday(new Date('2026-10-20T23:00:00.000Z')).toISOString()).toBe(
      '2026-10-21T00:00:00.000Z',
    );
  });

  it('carries the local calendar fields on the UTC getters', () => {
    const local = watCalendarFields(new Date('2026-12-31T23:30:00.000Z'));

    expect(local.getUTCFullYear()).toBe(2027);
    expect(local.getUTCMonth()).toBe(0);
    expect(local.getUTCDate()).toBe(1);
    expect(local.getUTCHours()).toBe(0);
  });
});
