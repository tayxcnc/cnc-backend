import { parseIsoDate } from '../common/calendar-date';
import {
  CHANGE_WINDOW_MS,
  bookingDateText,
  bookingStart,
  changeableUntil,
  insideChangeWindow,
} from './reservation-rules';

/** 2026-10-24 19:00 in Jos is 18:00 UTC. */
const DATE = parseIsoDate('2026-10-24')!;
const SEVEN_PM = 19 * 60;
const START = new Date('2026-10-24T18:00:00.000Z');

describe('the 24-hour change window (Q6)', () => {
  it('starts the booking on the wall clock in Jos', () => {
    expect(bookingStart(DATE, SEVEN_PM)).toEqual(START);
    expect(changeableUntil(DATE, SEVEN_PM)).toEqual(
      new Date(START.getTime() - CHANGE_WINDOW_MS),
    );
  });

  it('allows a change exactly 24 hours ahead and refuses one a millisecond later', () => {
    const edge = START.getTime() - 24 * 60 * 60 * 1000;

    expect(insideChangeWindow(DATE, SEVEN_PM, new Date(edge - 60_000))).toBe(
      false,
    );
    expect(insideChangeWindow(DATE, SEVEN_PM, new Date(edge))).toBe(false);
    expect(insideChangeWindow(DATE, SEVEN_PM, new Date(edge + 1))).toBe(true);
  });

  it('refuses inside the day and after the booking has started', () => {
    expect(
      insideChangeWindow(DATE, SEVEN_PM, new Date('2026-10-24T08:00:00Z')),
    ).toBe(true);
    expect(
      insideChangeWindow(DATE, SEVEN_PM, new Date('2026-10-25T08:00:00Z')),
    ).toBe(true);
  });
});

describe('bookingDateText', () => {
  it('writes the date as the website does, without shifting the day', () => {
    expect(bookingDateText(DATE)).toBe('Sat 24 Oct 2026');
    expect(bookingDateText(parseIsoDate('2026-01-01')!)).toBe('Thu 1 Jan 2026');
  });
});
