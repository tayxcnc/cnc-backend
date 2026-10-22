import { parseIsoDate } from '../common/calendar-date';
import { watMinutesOfDay } from '../common/wat';
import { hoursOn } from './opening-hours';

describe('hoursOn', () => {
  const week = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek,
    isClosed: dayOfWeek === 0,
    opensAtMinutes: dayOfWeek === 0 ? null : 480,
    closesAtMinutes: dayOfWeek === 0 ? null : 1440,
  }));

  it('reads the day the calendar date falls on', () => {
    // 2026-10-22 is a Thursday; 2026-10-25 a Sunday.
    expect(hoursOn(week, parseIsoDate('2026-10-22')!).dayOfWeek).toBe(4);
    expect(hoursOn(week, parseIsoDate('2026-10-25')!).isClosed).toBe(true);
  });

  it('answers a missing day, or a week not set, as closed', () => {
    expect(hoursOn(week.slice(1), parseIsoDate('2026-10-25')!)).toEqual({
      dayOfWeek: 0,
      isClosed: true,
      opensAtMinutes: null,
      closesAtMinutes: null,
    });
    expect(hoursOn(null, parseIsoDate('2026-10-22')!).isClosed).toBe(true);
  });
});

describe('watMinutesOfDay', () => {
  it('is the minute in Jos, an hour ahead of UTC', () => {
    expect(watMinutesOfDay(new Date('2026-10-22T18:30:59.000Z'))).toBe(1170);
    // 23:15 UTC is 00:15 the next day in Jos.
    expect(watMinutesOfDay(new Date('2026-10-22T23:15:00.000Z'))).toBe(15);
  });
});
