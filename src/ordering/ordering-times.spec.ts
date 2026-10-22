import { AddressZone, Fulfilment } from '../../generated/cnc-client';
import type { OpeningHoursDayValue } from '../settings/opening-hours';
import {
  asapOpen,
  isOrderTime,
  leadMinutes,
  orderSlots,
} from './ordering-times';

const SETTINGS = {
  lastOrderSlotMinutes: 1410,
  slotStepMinutes: 30,
  leadPickupMinutes: 60,
  leadJosMinutes: 90,
  leadOutsideMinutes: 120,
};

const OPEN: OpeningHoursDayValue = {
  dayOfWeek: 4,
  isClosed: false,
  opensAtMinutes: 480,
  closesAtMinutes: 1440,
};

const CLOSED: OpeningHoursDayValue = {
  dayOfWeek: 4,
  isClosed: true,
  opensAtMinutes: null,
  closesAtMinutes: null,
};

describe('leadMinutes', () => {
  it('is the pickup, Jos or Plateau lead time (the website’s leadFor)', () => {
    expect(leadMinutes(SETTINGS, Fulfilment.PICKUP, null)).toBe(60);
    expect(leadMinutes(SETTINGS, Fulfilment.PICKUP, AddressZone.PLATEAU)).toBe(
      60,
    );
    expect(leadMinutes(SETTINGS, Fulfilment.DELIVERY, AddressZone.JOS)).toBe(
      90,
    );
    expect(
      leadMinutes(SETTINGS, Fulfilment.DELIVERY, AddressZone.PLATEAU),
    ).toBe(120);
  });
});

describe('isOrderTime', () => {
  it('is from opening to the last order slot on an open day', () => {
    expect(isOrderTime(OPEN, 480, SETTINGS)).toBe(true);
    expect(isOrderTime(OPEN, 1410, SETTINGS)).toBe(true);
    expect(isOrderTime(OPEN, 1411, SETTINGS)).toBe(false);
    expect(isOrderTime(OPEN, 479, SETTINGS)).toBe(false);
    expect(isOrderTime(CLOSED, 720, SETTINGS)).toBe(false);
  });

  it('stops before an early closing', () => {
    const early = { ...OPEN, closesAtMinutes: 1320 };

    expect(isOrderTime(early, 1290, SETTINGS)).toBe(true);
    expect(isOrderTime(early, 1320, SETTINGS)).toBe(false);
  });
});

describe('asapOpen (plan §8.3)', () => {
  it('is offered while open and the order arrives by 23:30', () => {
    expect(asapOpen(OPEN, 600, 90, SETTINGS)).toBe(true);
    // 22:00 + 90 = 23:30, the last slot: still offered.
    expect(asapOpen(OPEN, 1320, 90, SETTINGS)).toBe(true);
    // 22:01 + 90 = 23:31.
    expect(asapOpen(OPEN, 1321, 90, SETTINGS)).toBe(false);
  });

  it('is refused before opening and on a closed day', () => {
    expect(asapOpen(OPEN, 479, 60, SETTINGS)).toBe(false);
    expect(asapOpen(OPEN, 480, 60, SETTINGS)).toBe(true);
    expect(asapOpen(CLOSED, 720, 60, SETTINGS)).toBe(false);
  });
});

describe('orderSlots', () => {
  it('offers today’s grid from now plus the lead', () => {
    // 19:10 + 90 = 20:40: the first slot is 21:00.
    expect(orderSlots(OPEN, 1150, 90, SETTINGS)).toEqual([
      '21:00',
      '21:30',
      '22:00',
      '22:30',
      '23:00',
      '23:30',
    ]);
  });

  it('counts from opening when CNC has not opened yet', () => {
    // 06:00, pickup: max(06:00, 08:00) + 60 = 09:00.
    expect(orderSlots(OPEN, 360, 60, SETTINGS)[0]).toBe('09:00');
  });

  it('offers none when the day is over or closed', () => {
    expect(orderSlots(OPEN, 1400, 60, SETTINGS)).toEqual([]);
    expect(orderSlots(CLOSED, null, 60, SETTINGS)).toEqual([]);
  });

  it('offers every slot of tomorrow, 08:00 to 23:30', () => {
    const slots = orderSlots(OPEN, null, 120, SETTINGS);

    expect(slots[0]).toBe('08:00');
    expect(slots[slots.length - 1]).toBe('23:30');
    expect(slots).toHaveLength(32);
  });

  it('follows the day’s own opening and the grid setting', () => {
    const late = { ...OPEN, opensAtMinutes: 600 };

    expect(
      orderSlots(late, null, 60, { ...SETTINGS, slotStepMinutes: 15 }).slice(
        0,
        3,
      ),
    ).toEqual(['10:00', '10:15', '10:30']);
  });
});
