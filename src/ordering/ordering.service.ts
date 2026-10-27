import { Injectable } from '@nestjs/common';
import { AddressZone, Fulfilment } from '../../generated/cnc-client';
import { addDays, formatIsoDate } from '../common/calendar-date';
import { watMinutesOfDay, watToday } from '../common/wat';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { clockText } from '../reception/reservation-rules';
import { hoursOn } from '../settings/opening-hours';
import { OpeningHoursService } from '../settings/opening-hours.service';
import type {
  OrderingConfigResponse,
  OrderingSlotsQuery,
  OrderingSlotsResponse,
} from './dto/ordering.dto';
import {
  asapOpen,
  leadMinutes,
  type OrderingTimeSettings,
  orderSlots,
} from './ordering-times';

/** The settings columns the public ordering reads use, and no others. */
const ORDERING_SETTINGS = {
  vatBps: true,
  deliveryJosKobo: true,
  deliveryOutsideKobo: true,
  lastOrderSlotMinutes: true,
  slotStepMinutes: true,
  leadPickupMinutes: true,
  leadJosMinutes: true,
  leadOutsideMinutes: true,
} as const;

/**
 * The website's ordering reads (plan §5.1, C6-4): the prices and times a
 * cart is built with, and the times an order placed now can be received.
 * Read from the one settings row and the opening hours, so an Owner's
 * change reaches the order page without a release. C7 adds the quote and
 * the checkout beside them, on the same rules (`ordering-times.ts`).
 *
 * Only the ordering columns are read: the approval limits, the deposit,
 * the printer and the bell's switches never leave the staff app.
 */
@Injectable()
export class OrderingService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly hours: OpeningHoursService,
  ) {}

  private settings() {
    return this.prisma.settings.findUniqueOrThrow({
      where: { singleton: true },
      select: ORDERING_SETTINGS,
    });
  }

  /** `GET /ordering/config`. */
  async config(): Promise<OrderingConfigResponse> {
    const row = await this.settings();

    return {
      vatBps: row.vatBps,
      pickup: { leadMinutes: row.leadPickupMinutes },
      zones: [
        {
          zone: AddressZone.JOS,
          feeKobo: row.deliveryJosKobo,
          leadMinutes: row.leadJosMinutes,
        },
        {
          zone: AddressZone.PLATEAU,
          feeKobo: row.deliveryOutsideKobo,
          leadMinutes: row.leadOutsideMinutes,
        },
      ],
      slotStepMinutes: row.slotStepMinutes,
      lastOrderSlot: clockText(row.lastOrderSlotMinutes),
    };
  }

  /** `GET /ordering/slots`: as the clock in Jos stands now. */
  async slots(query: OrderingSlotsQuery): Promise<OrderingSlotsResponse> {
    const now = new Date();
    const settings: OrderingTimeSettings = await this.settings();
    const { days } = await this.hours.read();
    const today = watToday(now);
    const tomorrow = addDays(today, 1);
    const nowMinutes = watMinutesOfDay(now);
    const lead = leadMinutes(
      settings,
      query.fulfilment,
      query.fulfilment === Fulfilment.DELIVERY ? (query.zone ?? null) : null,
    );
    const todayHours = hoursOn(days, today);

    return {
      asap: asapOpen(todayHours, nowMinutes, lead, settings),
      leadMinutes: lead,
      todayDate: formatIsoDate(today),
      today: orderSlots(todayHours, nowMinutes, lead, settings),
      tomorrowDate: formatIsoDate(tomorrow),
      tomorrow: orderSlots(hoursOn(days, tomorrow), null, lead, settings),
    };
  }
}
