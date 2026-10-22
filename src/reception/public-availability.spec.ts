import { parseIsoDate } from '../common/calendar-date';
import {
  type DayHours,
  arrivalTimes,
  publicTableStatus,
} from './reservation-rules';

const DATE = parseIsoDate('2026-10-22')!;
const OPEN: DayHours = {
  isClosed: false,
  opensAtMinutes: 480,
  closesAtMinutes: 1440,
};
const SETTINGS = { lastArrivalMinutes: 1380, slotStepMinutes: 30 };

const times = (now: Date, hours: DayHours = OPEN) =>
  arrivalTimes({ businessDate: DATE, now, hours, settings: SETTINGS });

describe('arrivalTimes', () => {
  it('offers the whole grid, 08:00 to 23:00, on a later day', () => {
    const offered = times(new Date('2026-10-21T09:00:00.000Z'));

    expect(offered[0]).toBe('08:00');
    expect(offered[offered.length - 1]).toBe('23:00');
    expect(offered).toHaveLength(31);
  });

  it('drops today’s passed times, the current minute included', () => {
    // 19:30 in Jos exactly: 19:30 is no longer later than now.
    expect(times(new Date('2026-10-22T18:30:00.000Z'))[0]).toBe('20:00');
    // 19:29 in Jos: 19:30 is still ahead.
    expect(times(new Date('2026-10-22T18:29:00.000Z'))[0]).toBe('19:30');
  });

  it('offers nothing after the last arrival or on a closed day', () => {
    expect(times(new Date('2026-10-22T22:00:00.000Z'))).toEqual([]);
    expect(
      times(new Date('2026-10-21T09:00:00.000Z'), {
        isClosed: true,
        opensAtMinutes: null,
        closesAtMinutes: null,
      }),
    ).toEqual([]);
  });

  it('follows a later opening and an earlier closing', () => {
    const offered = times(new Date('2026-10-21T09:00:00.000Z'), {
      isClosed: false,
      opensAtMinutes: 600,
      closesAtMinutes: 1200,
    });

    expect(offered[0]).toBe('10:00');
    expect(offered[offered.length - 1]).toBe('19:30');
  });
});

describe('publicTableStatus', () => {
  it('names a Locked table BLOCKED and keeps the rest', () => {
    expect(publicTableStatus('LOCKED')).toBe('BLOCKED');
    expect(publicTableStatus('AVAILABLE')).toBe('AVAILABLE');
    expect(publicTableStatus('RESERVED')).toBe('RESERVED');
    expect(publicTableStatus('OCCUPIED')).toBe('OCCUPIED');
  });
});
