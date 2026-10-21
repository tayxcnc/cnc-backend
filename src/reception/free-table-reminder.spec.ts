import {
  freeTableReminderItem,
  isReminderDue,
  seatedForText,
} from './free-table-reminder';

const SINCE = new Date('2026-10-21T15:00:00.000Z');
const after = (minutes: number) => new Date(SINCE.getTime() + minutes * 60_000);

describe('isReminderDue', () => {
  it('is due from the reminder time on, not a minute before', () => {
    expect(isReminderDue(SINCE, after(179), 180)).toBe(false);
    expect(isReminderDue(SINCE, after(180), 180)).toBe(true);
    expect(isReminderDue(SINCE, after(15), 15)).toBe(true);
  });
});

describe('seatedForText', () => {
  it('words under an hour in minutes (D37), never "0 hours"', () => {
    expect(seatedForText(SINCE, after(15))).toBe('15 minutes');
    expect(seatedForText(SINCE, after(1))).toBe('1 minute');
    expect(seatedForText(SINCE, after(59))).toBe('59 minutes');
  });

  it('words an hour or more in whole hours, as the demo does', () => {
    expect(seatedForText(SINCE, after(60))).toBe('1 hour');
    expect(seatedForText(SINCE, after(185))).toBe('3 hours');
  });
});

describe('freeTableReminderItem', () => {
  it('is the demo’s bell item, opening Reception', () => {
    expect(
      freeTableReminderItem(
        { tableId: 't1', tableName: 'Booth 1', guest: 'Ada', since: SINCE },
        after(185),
      ),
    ).toEqual({
      id: 'free:t1:2026-10-21T15:00:00.000Z',
      title: 'Free Table Reminder',
      detail: 'Booth 1 · Ada seated 3 hours ago. Free it if they have left.',
      page: 'reception',
      category: 'Reception',
    });
  });

  it('says "Guests" when no name was given', () => {
    expect(
      freeTableReminderItem(
        { tableId: 't1', tableName: 'Booth 1', guest: '', since: SINCE },
        after(30),
      ).detail,
    ).toBe(
      'Booth 1 · Guests seated 30 minutes ago. Free it if they have left.',
    );
  });
});
