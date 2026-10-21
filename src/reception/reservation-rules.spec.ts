import {
  ReservationSource,
  TableSessionStatus,
} from '../../generated/cnc-client';
import { parseIsoDate } from '../common/calendar-date';
import {
  ARRIVAL_SLOT_MESSAGE,
  CLOSED_DAY_MESSAGE,
  FUTURE_TIME_MESSAGE,
  OPENING_HOURS_MESSAGE,
  bigPartyMessage,
} from './reception-messages';
import {
  type DayHours,
  arrivalProblem,
  bigPartyProblem,
  bookingStart,
  clockMinutes,
  clockText,
  floorStatus,
  guestPhone,
  tableRef,
} from './reservation-rules';

const DATE = parseIsoDate('2026-10-22')!;
const OPEN: DayHours = {
  isClosed: false,
  opensAtMinutes: 480,
  closesAtMinutes: 1440,
};
const SETTINGS = { lastArrivalMinutes: 1380, slotStepMinutes: 30 };
/** 2026-10-22 10:00 in Jos (09:00 UTC). */
const MORNING = new Date('2026-10-22T09:00:00.000Z');

const problem = (
  source: ReservationSource,
  startMinutes: number,
  overrides: { now?: Date; hours?: DayHours } = {},
) =>
  arrivalProblem({
    source,
    businessDate: DATE,
    startMinutes,
    now: overrides.now ?? MORNING,
    hours: overrides.hours ?? OPEN,
    settings: SETTINGS,
  });

describe('clockMinutes and clockText', () => {
  it('reads and writes zero-padded 24-hour times', () => {
    expect(clockMinutes('19:30')).toBe(1170);
    expect(clockMinutes('00:00')).toBe(0);
    expect(clockMinutes('23:59')).toBe(1439);
    expect(clockText(1170)).toBe('19:30');
    expect(clockText(5)).toBe('00:05');
  });

  it('refuses anything that is not HH:mm', () => {
    for (const text of ['7:30', '24:00', '19:60', '19:30:00', '', '1930']) {
      expect(clockMinutes(text)).toBeNull();
    }
  });
});

describe('bookingStart', () => {
  it('is the wall clock in Jos, an hour ahead of UTC', () => {
    expect(bookingStart(DATE, 1140).toISOString()).toBe(
      '2026-10-22T18:00:00.000Z',
    );
    expect(bookingStart(DATE, 30).toISOString()).toBe(
      '2026-10-21T23:30:00.000Z',
    );
  });
});

describe('arrivalProblem', () => {
  it('takes a Reception arrival at the current minute (the demo’s >= now), and refuses one before it', () => {
    expect(problem(ReservationSource.RECEPTION, 600)).toBeNull();
    expect(problem(ReservationSource.RECEPTION, 599)).toBe(FUTURE_TIME_MESSAGE);
  });

  it('asks an online arrival to be after now, as the website lists only later times', () => {
    expect(problem(ReservationSource.WEB, 600)).toBe(FUTURE_TIME_MESSAGE);
    expect(problem(ReservationSource.WEB, 630)).toBeNull();
  });

  it('refuses a day the opening hours mark closed, for every channel', () => {
    const closed: DayHours = {
      isClosed: true,
      opensAtMinutes: null,
      closesAtMinutes: null,
    };

    for (const source of Object.values(ReservationSource)) {
      expect(problem(source, 1140, { hours: closed })).toBe(CLOSED_DAY_MESSAGE);
    }
  });

  it('holds Reception to the opening hours, 08:00 to 23:59 (Q30), on any minute', () => {
    const night = new Date('2026-10-21T12:00:00.000Z');

    expect(problem(ReservationSource.RECEPTION, 479, { now: night })).toBe(
      OPENING_HOURS_MESSAGE,
    );
    expect(
      problem(ReservationSource.RECEPTION, 480, { now: night }),
    ).toBeNull();
    expect(
      problem(ReservationSource.RECEPTION, 1439, { now: night }),
    ).toBeNull();
    expect(
      problem(ReservationSource.RECEPTION, 1417, { now: night }),
    ).toBeNull();
    expect(
      problem(ReservationSource.RECEPTION, 1320, {
        now: night,
        hours: { isClosed: false, opensAtMinutes: 480, closesAtMinutes: 1320 },
      }),
    ).toBe(OPENING_HOURS_MESSAGE);
  });

  it('holds the website and the app to the 30-minute grid and the 23:00 last arrival (Q30)', () => {
    const night = new Date('2026-10-21T12:00:00.000Z');

    for (const source of [ReservationSource.WEB, ReservationSource.APP]) {
      expect(problem(source, 1380, { now: night })).toBeNull();
      expect(problem(source, 480, { now: night })).toBeNull();
      expect(problem(source, 1410, { now: night })).toBe(ARRIVAL_SLOT_MESSAGE);
      expect(problem(source, 1155, { now: night })).toBe(ARRIVAL_SLOT_MESSAGE);
      expect(problem(source, 470, { now: night })).toBe(OPENING_HOURS_MESSAGE);
    }
  });
});

describe('bigPartyProblem', () => {
  it('sends 4+ in Dining and 5+ in the Lounge to the team from the website and the app', () => {
    expect(bigPartyProblem(ReservationSource.WEB, 4, 4)).toBe(
      'For four or more guests, speak to our team and we will arrange suitable seating.',
    );
    expect(bigPartyProblem(ReservationSource.APP, 5, 5)).toBe(
      'For five or more guests, speak to our team and we will arrange suitable seating.',
    );
    expect(bigPartyProblem(ReservationSource.WEB, 3, 4)).toBeNull();
  });

  it('never refuses Reception, which is the team', () => {
    expect(bigPartyProblem(ReservationSource.RECEPTION, 8, 4)).toBeNull();
  });

  it('spells the threshold in figures beyond twelve', () => {
    expect(bigPartyMessage(15)).toBe(
      'For 15 or more guests, speak to our team and we will arrange suitable seating.',
    );
  });
});

describe('guestPhone', () => {
  it('stores a Nigerian mobile number as 0 plus 10 digits however it is typed', () => {
    expect(guestPhone('0803 123 4567')).toBe('08031234567');
    expect(guestPhone('+234-803-123-4567')).toBe('08031234567');
    expect(guestPhone('08031234567')).toBe('08031234567');
  });

  it('keeps any other number as typed, trimmed', () => {
    expect(guestPhone('  +44 20 7946 0958 ')).toBe('+44 20 7946 0958');
    expect(guestPhone('0800')).toBe('0800');
  });
});

describe('tableRef', () => {
  it('is the room’s initial and the code, as the demo’s table ids are', () => {
    expect(tableRef('Diner', 'B1')).toBe('D-B1');
    expect(tableRef('Lounge', 'TS1')).toBe('L-TS1');
  });
});

describe('floorStatus', () => {
  it('follows plan §7.5: Locked always, Occupied today only, then Reserved, then Available', () => {
    const status = (
      session: TableSessionStatus | null,
      isToday: boolean,
      booked: boolean,
    ) => floorStatus({ session, isToday, booked });

    expect(status(TableSessionStatus.LOCKED, false, true)).toBe('LOCKED');
    expect(status(TableSessionStatus.OCCUPIED, true, true)).toBe('OCCUPIED');
    expect(status(TableSessionStatus.OCCUPIED, false, true)).toBe('RESERVED');
    expect(status(TableSessionStatus.OCCUPIED, false, false)).toBe('AVAILABLE');
    expect(status(null, true, true)).toBe('RESERVED');
    expect(status(null, true, false)).toBe('AVAILABLE');
  });
});
