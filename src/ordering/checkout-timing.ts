import {
  AddressZone,
  CheckoutTiming,
  Fulfilment,
} from '../../generated/cnc-client';
import { addDays, formatIsoDate, parseIsoDate } from '../common/calendar-date';
import { watInstantAt, watMinutesOfDay, watToday } from '../common/wat';
import { bookingDateText } from '../reception/reservation-rules';
import { hoursOn, type OpeningHoursDayValue } from '../settings/opening-hours';
import {
  ASAP_UNAVAILABLE_MESSAGE,
  CHECKOUT_TIME_MESSAGE,
} from './checkout-messages';
import {
  asapOpen,
  leadMinutes,
  type OrderingTimeSettings,
  orderSlots,
} from './ordering-times';

/** What a checkout asked for. `date` and `time` only for `SCHEDULED`. */
export interface TimingRequest {
  timing: CheckoutTiming;
  date?: string;
  time?: string;
}

/** A timing the checkout accepted, as it stores it. */
export interface JudgedTiming {
  timing: CheckoutTiming;
  /** The chosen slot as an instant; null for as soon as possible. */
  scheduledFor: Date | null;
  /** The confirmation page's words (the website's `timingText`). */
  timingText: string;
}

/**
 * Judge a checkout's timing at `now` (plan §8.3, C7-1) with the very
 * functions `GET /ordering/slots` offers times from (`ordering-times.ts`),
 * so a time offered is a time accepted:
 *
 * - as soon as possible only while `asapOpen` (CNC open now and now plus
 *   the lead no later than the last order slot);
 * - a scheduled time only on today's or tomorrow's date in Jos, and only
 *   one of that day's `orderSlots`.
 *
 * The words are the website's `timingText`: "Sat 24 Oct 2026 at 19:30",
 * "As soon as possible, about 90 minutes", and for elsewhere in Plateau
 * "As soon as possible, 120 minutes or more, we will call to confirm the
 * time", with the lead read from the settings rather than the site's
 * constants.
 */
export function judgeTiming(input: {
  request: TimingRequest;
  now: Date;
  settings: OrderingTimeSettings;
  days: OpeningHoursDayValue[] | null;
  fulfilment: Fulfilment;
  zone: AddressZone | null;
}): JudgedTiming | { problem: string } {
  const { request, now, settings, days, fulfilment, zone } = input;
  const lead = leadMinutes(settings, fulfilment, zone);
  const today = watToday(now);

  if (request.timing === CheckoutTiming.ASAP) {
    if (!asapOpen(hoursOn(days, today), watMinutesOfDay(now), lead, settings)) {
      return { problem: ASAP_UNAVAILABLE_MESSAGE };
    }

    return {
      timing: CheckoutTiming.ASAP,
      scheduledFor: null,
      timingText:
        fulfilment === Fulfilment.DELIVERY && zone === AddressZone.PLATEAU
          ? `As soon as possible, ${lead} minutes or more, we will call to confirm the time`
          : `As soon as possible, about ${lead} minutes`,
    };
  }

  const date = request.date === undefined ? null : parseIsoDate(request.date);
  const tomorrow = addDays(today, 1);

  if (date === null || request.time === undefined) {
    return { problem: CHECKOUT_TIME_MESSAGE };
  }

  const isToday = formatIsoDate(date) === formatIsoDate(today);
  const isTomorrow = formatIsoDate(date) === formatIsoDate(tomorrow);

  if (!isToday && !isTomorrow) return { problem: CHECKOUT_TIME_MESSAGE };

  const offered = orderSlots(
    hoursOn(days, date),
    isToday ? watMinutesOfDay(now) : null,
    lead,
    settings,
  );

  if (!offered.includes(request.time)) {
    return { problem: CHECKOUT_TIME_MESSAGE };
  }

  return {
    timing: CheckoutTiming.SCHEDULED,
    scheduledFor: watInstantAt(date, request.time),
    timingText: `${bookingDateText(date)} at ${request.time}`,
  };
}
