import { parseIsoDate } from '../common/calendar-date';
import {
  REMINDER_LEAD_MS,
  initialReminderStamp,
  reminderDue,
  reminderDueAt,
} from './reservation-rules';

/** 2026-10-24 19:00 in Jos is 18:00 UTC. */
const DATE = parseIsoDate('2026-10-24')!;
const SEVEN_PM = 19 * 60;
const START = new Date('2026-10-24T18:00:00.000Z').getTime();
const DUE = START - 24 * 60 * 60 * 1000;

describe('booking reminders (Q32)', () => {
  it('fall due 24 hours before the booking starts in Jos', () => {
    expect(REMINDER_LEAD_MS).toBe(24 * 60 * 60 * 1000);
    expect(reminderDueAt(DATE, SEVEN_PM).getTime()).toBe(DUE);
  });

  it('are due from that instant until the booking starts, and never after', () => {
    expect(reminderDue(DATE, SEVEN_PM, new Date(DUE - 1))).toBe(false);
    expect(reminderDue(DATE, SEVEN_PM, new Date(DUE))).toBe(true);
    expect(reminderDue(DATE, SEVEN_PM, new Date(START - 1))).toBe(true);
    expect(reminderDue(DATE, SEVEN_PM, new Date(START))).toBe(false);
  });

  it('are stamped as handled for a booking made or moved under 24 hours ahead, and left to the sweep otherwise', () => {
    // 24 hours ahead exactly: not "less than 24 hours", so one is sent.
    expect(initialReminderStamp(DATE, SEVEN_PM, new Date(DUE))).toBeNull();
    expect(initialReminderStamp(DATE, SEVEN_PM, new Date(DUE - 1))).toBeNull();

    const late = new Date(DUE + 1);
    expect(initialReminderStamp(DATE, SEVEN_PM, late)).toEqual(late);
  });
});
