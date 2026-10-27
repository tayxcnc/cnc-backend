import {
  AddressZone,
  CheckoutTiming,
  Fulfilment,
} from '../../generated/cnc-client';
import type { OpeningHoursDayValue } from '../settings/opening-hours';
import {
  ASAP_UNAVAILABLE_MESSAGE,
  CHECKOUT_TIME_MESSAGE,
} from './checkout-messages';
import { judgeTiming } from './checkout-timing';

const SETTINGS = {
  lastOrderSlotMinutes: 1410,
  slotStepMinutes: 30,
  leadPickupMinutes: 60,
  leadJosMinutes: 90,
  leadOutsideMinutes: 120,
};

const OPEN_DAILY: OpeningHoursDayValue[] = [0, 1, 2, 3, 4, 5, 6].map(
  (dayOfWeek) => ({
    dayOfWeek,
    isClosed: false,
    opensAtMinutes: 480,
    closesAtMinutes: 1440,
  }),
);

/** Friday 23 October 2026, `hh:mm` in Jos (UTC+1). */
const at = (hours: number, minutes = 0) =>
  new Date(Date.UTC(2026, 9, 23, hours - 1, minutes));

const judge = (
  request: Parameters<typeof judgeTiming>[0]['request'],
  now: Date,
  fulfilment: Fulfilment = Fulfilment.DELIVERY,
  zone: AddressZone | null = AddressZone.JOS,
  days: OpeningHoursDayValue[] | null = OPEN_DAILY,
) => judgeTiming({ request, now, settings: SETTINGS, days, fulfilment, zone });

describe('judgeTiming (plan §8.3)', () => {
  it('words as soon as possible with the lead by zone, as the website does', () => {
    const asap = { timing: CheckoutTiming.ASAP };

    expect(judge(asap, at(12))).toEqual({
      timing: CheckoutTiming.ASAP,
      scheduledFor: null,
      timingText: 'As soon as possible, about 90 minutes',
    });
    expect(judge(asap, at(12), Fulfilment.PICKUP, null)).toMatchObject({
      timingText: 'As soon as possible, about 60 minutes',
    });
    expect(
      judge(asap, at(12), Fulfilment.DELIVERY, AddressZone.PLATEAU),
    ).toMatchObject({
      timingText:
        'As soon as possible, 120 minutes or more, we will call to confirm the time',
    });
  });

  it('refuses as soon as possible before opening and when the lead passes 23:30', () => {
    const asap = { timing: CheckoutTiming.ASAP };

    expect(judge(asap, at(7, 30))).toEqual({
      problem: ASAP_UNAVAILABLE_MESSAGE,
    });
    // 22:00 + 90 = 23:30, the last slot: still offered.
    expect(judge(asap, at(22))).toMatchObject({ timing: CheckoutTiming.ASAP });
    expect(judge(asap, at(22, 1))).toEqual({
      problem: ASAP_UNAVAILABLE_MESSAGE,
    });
    expect(
      judge(asap, at(12), Fulfilment.DELIVERY, AddressZone.JOS, null),
    ).toEqual({
      problem: ASAP_UNAVAILABLE_MESSAGE,
    });
  });

  it('takes an offered slot today or tomorrow, as an instant in Jos', () => {
    expect(
      judge(
        { timing: CheckoutTiming.SCHEDULED, date: '2026-10-23', time: '13:30' },
        at(12),
      ),
    ).toEqual({
      timing: CheckoutTiming.SCHEDULED,
      scheduledFor: new Date('2026-10-23T12:30:00.000Z'),
      timingText: 'Fri 23 Oct 2026 at 13:30',
    });
    expect(
      judge(
        { timing: CheckoutTiming.SCHEDULED, date: '2026-10-24', time: '08:00' },
        at(12),
      ),
    ).toMatchObject({ timingText: 'Sat 24 Oct 2026 at 08:00' });
  });

  it.each([
    ['inside the lead', '2026-10-23', '13:00'],
    ['off the grid', '2026-10-23', '14:15'],
    ['past the last slot', '2026-10-24', '23:45'],
    ['the day after tomorrow', '2026-10-25', '12:00'],
    ['yesterday', '2026-10-22', '12:00'],
  ])('refuses a time %s', (_name, date, time) => {
    expect(
      judge({ timing: CheckoutTiming.SCHEDULED, date, time }, at(12)),
    ).toEqual({ problem: CHECKOUT_TIME_MESSAGE });
  });

  it('refuses a scheduled order on a closed day', () => {
    const closedSaturday = OPEN_DAILY.map((day) =>
      day.dayOfWeek === 6
        ? {
            ...day,
            isClosed: true,
            opensAtMinutes: null,
            closesAtMinutes: null,
          }
        : day,
    );

    expect(
      judge(
        { timing: CheckoutTiming.SCHEDULED, date: '2026-10-24', time: '12:00' },
        at(12),
        Fulfilment.DELIVERY,
        AddressZone.JOS,
        closedSaturday,
      ),
    ).toEqual({ problem: CHECKOUT_TIME_MESSAGE });
  });
});
