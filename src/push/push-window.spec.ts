import type { OpeningHoursDayValue } from '../settings/opening-hours';
import {
  FALLBACK_WINDOW,
  STAFF_WINDOW_GRACE_MIN,
  holdUntil,
  nextStaffWindowOpen,
  staffWindow,
} from './push-window';

/**
 * C10, D6: the staff window is each Lagos day's opening hours, 60 minutes
 * wider each side; a week with no open day falls back to 07:00 to 22:00.
 * Instants are written in UTC; Jos is an hour ahead all year.
 */

/** The migration's seeded week: 08:00 to midnight every day. */
const SEEDED: OpeningHoursDayValue[] = Array.from({ length: 7 }, (_, d) => ({
  dayOfWeek: d,
  isClosed: false,
  opensAtMinutes: 480,
  closesAtMinutes: 1440,
}));

/** The seeded week with Monday (1) closed. */
const MONDAY_CLOSED = SEEDED.map((day) =>
  day.dayOfWeek === 1
    ? { ...day, isClosed: true, opensAtMinutes: null, closesAtMinutes: null }
    : day,
);

const ALL_CLOSED = SEEDED.map((day) => ({
  ...day,
  isClosed: true,
  opensAtMinutes: null,
  closesAtMinutes: null,
}));

const at = (iso: string) => new Date(iso);

describe('the staff window (D6)', () => {
  it('is an hour each side of the opening hours, and 07:00 to 22:00 without any', () => {
    expect(STAFF_WINDOW_GRACE_MIN).toBe(60);
    expect(FALLBACK_WINDOW).toEqual({
      opensAtMinutes: 420,
      closesAtMinutes: 1320,
    });
  });

  it('opens at 07:00 in Jos on a day open from 08:00', () => {
    // Friday 30 October 2026: 06:59 and 07:00 in Jos.
    expect(staffWindow(SEEDED, at('2026-10-30T05:59:00.000Z'))).toBeNull();
    expect(staffWindow(SEEDED, at('2026-10-30T06:00:00.000Z'))).toEqual({
      opensAt: at('2026-10-30T06:00:00.000Z'),
      closesAt: at('2026-10-31T00:00:00.000Z'),
    });
  });

  it('runs until 01:00 the next morning on a day open to midnight', () => {
    // 00:59 on Saturday in Jos is still Friday's window; 01:00 is not.
    expect(staffWindow(SEEDED, at('2026-10-30T23:59:00.000Z'))).not.toBeNull();
    expect(
      staffWindow(SEEDED, at('2026-10-30T23:59:00.000Z'))?.opensAt,
    ).toEqual(at('2026-10-30T06:00:00.000Z'));
    expect(staffWindow(SEEDED, at('2026-10-31T00:00:00.000Z'))).toBeNull();
    expect(nextStaffWindowOpen(SEEDED, at('2026-10-31T00:00:00.000Z'))).toEqual(
      at('2026-10-31T06:00:00.000Z'),
    );
  });

  it('keeps a closed day closed, after the evening before has run its grace', () => {
    // Monday 2 November 2026 is closed. Sunday's window still runs to 01:00.
    expect(
      staffWindow(MONDAY_CLOSED, at('2026-11-01T23:30:00.000Z')),
    ).not.toBeNull();
    expect(
      staffWindow(MONDAY_CLOSED, at('2026-11-02T11:00:00.000Z')),
    ).toBeNull();
    expect(
      nextStaffWindowOpen(MONDAY_CLOSED, at('2026-11-02T11:00:00.000Z')),
    ).toEqual(at('2026-11-03T06:00:00.000Z'));
  });

  it('falls back to 07:00 to 22:00 in Jos when no day is open, or the week is not set', () => {
    for (const days of [ALL_CLOSED, null, []]) {
      expect(staffWindow(days, at('2026-10-30T05:59:00.000Z'))).toBeNull();
      expect(staffWindow(days, at('2026-10-30T06:00:00.000Z'))).not.toBeNull();
      expect(staffWindow(days, at('2026-10-30T20:59:00.000Z'))).not.toBeNull();
      expect(staffWindow(days, at('2026-10-30T21:00:00.000Z'))).toBeNull();
      expect(nextStaffWindowOpen(days, at('2026-10-30T21:00:00.000Z'))).toEqual(
        at('2026-10-31T06:00:00.000Z'),
      );
    }
  });

  it('reads the Lagos date, not the UTC one, in the hour they differ', () => {
    // 23:30 UTC on Friday is 00:30 on Saturday in Jos: outside the
    // fallback window, which reopens at 07:00 on Saturday in Jos.
    expect(staffWindow(null, at('2026-10-30T23:30:00.000Z'))).toBeNull();
    expect(nextStaffWindowOpen(null, at('2026-10-30T23:30:00.000Z'))).toEqual(
      at('2026-10-31T06:00:00.000Z'),
    );
  });
});

describe('holdUntil (D6)', () => {
  // 03:00 on Saturday 31 October in Jos.
  const NIGHT = at('2026-10-31T02:00:00.000Z');

  it('holds a non-urgent push to an off-duty person until the window opens', () => {
    expect(
      holdUntil({ urgent: false, onDuty: false, days: SEEDED, now: NIGHT }),
    ).toEqual(at('2026-10-31T06:00:00.000Z'));
  });

  it('never holds an urgent push, or one to a person on duty', () => {
    expect(
      holdUntil({ urgent: true, onDuty: false, days: SEEDED, now: NIGHT }),
    ).toBeNull();
    expect(
      holdUntil({ urgent: false, onDuty: true, days: SEEDED, now: NIGHT }),
    ).toBeNull();
  });

  it('never holds inside the window', () => {
    expect(
      holdUntil({
        urgent: false,
        onDuty: false,
        days: SEEDED,
        now: at('2026-10-31T12:00:00.000Z'),
      }),
    ).toBeNull();
  });
});
