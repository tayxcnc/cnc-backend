import { AddressZone, Fulfilment } from '../../generated/cnc-client';
import { clockText } from '../reception/reservation-rules';
import type { OpeningHoursDayValue } from '../settings/opening-hours';

/**
 * When a web order can be received (plan §8.3), pure so the unit suite
 * covers every hour of the day without a clock. The website's own rules
 * (`components/order/OrderApp.tsx`: `leadFor`, `asapOpen`, `laterSlots`),
 * with its constants read from the settings and the opening hours instead:
 *
 * - **Lead time** by how the order is received: pickup, or delivery within
 *   Jos or elsewhere in Plateau (`leadPickupMinutes`, `leadJosMinutes`,
 *   `leadOutsideMinutes`).
 * - **A time an order can be received at** on a day: the day is open, the
 *   time is from opening to before closing, and no later than the last
 *   order slot (`lastOrderSlotMinutes`, 23:30).
 * - **As soon as possible** only while CNC is open now and now plus the
 *   lead is such a time (plan §8.3: "ASAP is refused when CNC is closed or
 *   when now + lead > 23:30").
 * - **Scheduled times** on the grid from the day's opening every
 *   `slotStepMinutes` (08:00, 08:30 … 23:30), today or tomorrow only. Today
 *   a time must be at least the lead after now, or after opening when CNC
 *   has not opened yet (the website's `max(now, open) + lead`); tomorrow
 *   every slot of the day, as the website offers.
 *
 * C7's checkout judges a chosen time with the same functions, so the slots
 * a customer is offered are exactly the times checkout accepts.
 */

/** The timing settings, as `Settings` stores them. */
export interface OrderingTimeSettings {
  lastOrderSlotMinutes: number;
  slotStepMinutes: number;
  leadPickupMinutes: number;
  leadJosMinutes: number;
  leadOutsideMinutes: number;
}

/** Minutes from placing an order to receiving it (the website's `leadFor`). */
export function leadMinutes(
  settings: OrderingTimeSettings,
  fulfilment: Fulfilment,
  zone: AddressZone | null,
): number {
  if (fulfilment === Fulfilment.PICKUP) return settings.leadPickupMinutes;

  return zone === AddressZone.PLATEAU
    ? settings.leadOutsideMinutes
    : settings.leadJosMinutes;
}

/** Whether a day's row says CNC opens at all. */
function isOpenDay(day: OpeningHoursDayValue): day is OpeningHoursDayValue & {
  opensAtMinutes: number;
  closesAtMinutes: number;
} {
  return (
    !day.isClosed && day.opensAtMinutes !== null && day.closesAtMinutes !== null
  );
}

/**
 * Whether an order can be received at `minutes` on a day with `day`'s
 * hours: open that day, from opening to before closing, and no later than
 * the last order slot.
 */
export function isOrderTime(
  day: OpeningHoursDayValue,
  minutes: number,
  settings: OrderingTimeSettings,
): boolean {
  return (
    isOpenDay(day) &&
    minutes >= day.opensAtMinutes &&
    minutes < day.closesAtMinutes &&
    minutes <= settings.lastOrderSlotMinutes
  );
}

/**
 * Whether "as soon as possible" is offered at `nowMinutes` (Lagos) on a day
 * with `today`'s hours: CNC is open now, and the order would arrive at a
 * time an order can be received.
 */
export function asapOpen(
  today: OpeningHoursDayValue,
  nowMinutes: number,
  lead: number,
  settings: OrderingTimeSettings,
): boolean {
  return (
    isOpenDay(today) &&
    nowMinutes >= today.opensAtMinutes &&
    nowMinutes < today.closesAtMinutes &&
    isOrderTime(today, nowMinutes + lead, settings)
  );
}

/**
 * The scheduled times offered on one day, as `HH:mm`, earliest first.
 * `nowMinutes` is the minute it is in Lagos when the day is today, and null
 * for tomorrow.
 */
export function orderSlots(
  day: OpeningHoursDayValue,
  nowMinutes: number | null,
  lead: number,
  settings: OrderingTimeSettings,
): string[] {
  if (!isOpenDay(day)) return [];

  const earliest =
    nowMinutes === null
      ? day.opensAtMinutes
      : Math.max(nowMinutes, day.opensAtMinutes) + lead;
  const slots: string[] = [];

  for (
    let minutes = day.opensAtMinutes;
    minutes < day.closesAtMinutes;
    minutes += settings.slotStepMinutes
  ) {
    if (minutes >= earliest && isOrderTime(day, minutes, settings)) {
      slots.push(clockText(minutes));
    }
  }

  return slots;
}
