import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReplaceOpeningHoursRequest } from './dto/opening-hours.dto';
import {
  DAY_NAMES,
  DAYS_IN_WEEK,
  MINUTES_IN_DAY,
  minutesLabel,
  type OpeningHoursDayInput,
  toOpeningHours,
  toStoredWeek,
  weekForAudit,
  weekRuleBroken,
} from './opening-hours';

/** Copied from TAY's spec, with CNC's audit view added. */
describe('opening hours', () => {
  /** A week of the test's own: 08:00 to midnight, closed on Sunday. */
  const week = (): OpeningHoursDayInput[] =>
    [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) =>
      dayOfWeek === 0
        ? { dayOfWeek, isClosed: true }
        : {
            dayOfWeek,
            isClosed: false,
            opensAtMinutes: 480,
            closesAtMinutes: 1440,
          },
    );

  const withDay = (day: OpeningHoursDayInput) =>
    week().map((existing) =>
      existing.dayOfWeek === day.dayOfWeek ? day : existing,
    );

  const EVERY_DAY_ONCE =
    'days must name each day of the week exactly once, from 0 (Sunday) to ' +
    '6 (Saturday).';

  it('counts the week as getDay() does, and ends a day at 1440', () => {
    expect(DAYS_IN_WEEK).toBe(7);
    expect(MINUTES_IN_DAY).toBe(1440);
    expect(DAY_NAMES[0]).toBe('Sunday');
    expect(DAY_NAMES[6]).toBe('Saturday');
  });

  describe('weekRuleBroken', () => {
    it('passes a whole week, in any order', () => {
      expect(weekRuleBroken(week())).toBeNull();
      expect(weekRuleBroken(week().reverse())).toBeNull();
    });

    it('passes a closed day sent back with null times, as the API answers it', () => {
      expect(
        weekRuleBroken(
          withDay({
            dayOfWeek: 0,
            isClosed: true,
            opensAtMinutes: null,
            closesAtMinutes: null,
          }),
        ),
      ).toBeNull();
    });

    it('refuses six days, eight days, and a day named twice', () => {
      expect(weekRuleBroken(week().slice(1))).toBe(EVERY_DAY_ONCE);
      expect(weekRuleBroken([...week(), week()[1]])).toBe(EVERY_DAY_ONCE);
      expect(
        weekRuleBroken(
          week().map((day) =>
            day.dayOfWeek === 6 ? { ...day, dayOfWeek: 5 } : day,
          ),
        ),
      ).toBe(EVERY_DAY_ONCE);
    });

    it('refuses a closed day that carries a time, naming the day', () => {
      expect(
        weekRuleBroken(
          withDay({ dayOfWeek: 0, isClosed: true, opensAtMinutes: 480 }),
        ),
      ).toBe('Sunday is closed, so it takes no opening or closing time.');
    });

    it('refuses an open day missing a time, naming the day', () => {
      expect(
        weekRuleBroken(
          withDay({ dayOfWeek: 2, isClosed: false, opensAtMinutes: 480 }),
        ),
      ).toBe(
        'Tuesday is open, so it needs both opensAtMinutes and closesAtMinutes.',
      );
    });

    it('refuses a day that closes at or before it opens', () => {
      for (const closesAtMinutes of [480, 300]) {
        expect(
          weekRuleBroken(
            withDay({
              dayOfWeek: 3,
              isClosed: false,
              opensAtMinutes: 480,
              closesAtMinutes,
            }),
          ),
        ).toBe(
          'Wednesday must close after it opens. A day closes no later than ' +
            'midnight (1440).',
        );
      }
    });

    it('leaves a malformed entry to the field rules', () => {
      expect(weekRuleBroken('not a list')).toBeNull();
      expect(weekRuleBroken([{ dayOfWeek: 7, isClosed: true }])).toBeNull();
    });

    it('refuses a day sent as a list, which no field rule reaches', () => {
      expect(weekRuleBroken([[], [], [], [], [], [], []])).toBe(
        'days must send each day as an object, not as a list.',
      );
    });
  });

  describe('toStoredWeek and toOpeningHours', () => {
    it('orders the days and stores absent times as null', () => {
      const stored = toStoredWeek(week().reverse());

      expect(stored.map((day) => day.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(stored[0]).toEqual({
        dayOfWeek: 0,
        isClosed: true,
        opensAtMinutes: null,
        closesAtMinutes: null,
      });
    });

    it('answers seven days, stamped with the newest write, and never a partial week', () => {
      const earlier = new Date('2026-10-14T08:00:00.000Z');
      const later = new Date('2026-10-14T09:30:00.000Z');
      const rows = toStoredWeek(week()).map((day) => ({
        ...day,
        updatedAt: day.dayOfWeek === 4 ? later : earlier,
      }));

      const answer = toOpeningHours(rows.reverse());
      expect(answer.isSet).toBe(true);
      expect(answer.updatedAt).toEqual(later);
      expect(answer.days?.map((day) => day.dayOfWeek)).toEqual([
        0, 1, 2, 3, 4, 5, 6,
      ]);

      expect(toOpeningHours(rows.slice(0, 6))).toEqual({
        isSet: false,
        days: null,
        updatedAt: null,
      });
    });
  });

  describe('the audit view', () => {
    it('writes minutes as a 24-hour clock, midnight at the end as 24:00', () => {
      expect(minutesLabel(0)).toBe('00:00');
      expect(minutesLabel(570)).toBe('09:30');
      expect(minutesLabel(1440)).toBe('24:00');
    });

    it('records one plain field per day, so a sentence names the day', () => {
      expect(weekForAudit(toStoredWeek(week()))).toEqual({
        sunday: 'Closed',
        monday: '08:00 until 24:00',
        tuesday: '08:00 until 24:00',
        wednesday: '08:00 until 24:00',
        thursday: '08:00 until 24:00',
        friday: '08:00 until 24:00',
        saturday: '08:00 until 24:00',
      });
      expect(weekForAudit(null)).toBeNull();
    });
  });

  describe('ReplaceOpeningHoursRequest', () => {
    const problems = async (body: unknown) =>
      (
        await validate(plainToInstance(ReplaceOpeningHoursRequest, body), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).length;

    it('accepts a whole week and refuses a broken one', async () => {
      expect(await problems({ days: week() })).toBe(0);
      expect(await problems({ days: week().slice(1) })).toBe(1);
    });

    it('refuses a day out of range, a string time, and an undeclared field', async () => {
      expect(
        await problems({
          days: [...week().slice(0, 6), { dayOfWeek: 7, isClosed: true }],
        }),
      ).toBeGreaterThan(0);
      expect(
        await problems({
          days: withDay({
            dayOfWeek: 1,
            isClosed: false,
            opensAtMinutes: '480',
            closesAtMinutes: 1440,
          } as never),
        }),
      ).toBeGreaterThan(0);
      expect(
        await problems({
          days: withDay({
            dayOfWeek: 0,
            isClosed: true,
            note: 'public holiday',
          } as never),
        }),
      ).toBeGreaterThan(0);
    });
  });
});
