import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { formatIsoDate, parseIsoDate } from '../common/calendar-date';
import { watToday } from '../common/wat';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { hoursOn } from '../settings/opening-hours';
import type {
  PublicVenuesResponse,
  VenueAvailabilityResponse,
} from './dto/public-venues.dto';
import {
  PAST_DATE_MESSAGE,
  VENUE_NOT_FOUND_MESSAGE,
} from './reception-messages';
import {
  HOLDING_STATUSES,
  arrivalTimes,
  floorStatus,
  publicTableStatus,
} from './reservation-rules';

/** The table columns the website may see. */
const PUBLIC_TABLE = {
  id: true,
  code: true,
  name: true,
  kind: true,
  capacity: true,
} as const;

/**
 * The booking page's public reads (plan §5.1, C6-4): the rooms with their
 * tables, and a room's floor plan for a date.
 *
 * A table's state is Reception's floor rule (`floorStatus`, plan §7.5) on
 * the same rows the floor reads (`HOLDING_STATUSES`, the open sessions),
 * so the website and Reception never disagree about a table, and the
 * arrival times are those the booking command accepts (`arrivalTimes`).
 * Nothing else leaves: no guest, booking, lock reason, bill or row id.
 * Tables staff have taken out of use are not listed.
 */
@Injectable()
export class PublicVenuesService {
  constructor(private readonly prisma: CncPrismaService) {}

  /** `GET /venues`. */
  async venues(): Promise<PublicVenuesResponse> {
    const venues = await this.prisma.venue.findMany({
      orderBy: [{ sort: 'asc' }, { slug: 'asc' }],
      select: { id: true, slug: true, customerTitle: true, bigParty: true },
    });
    const tables = await this.prisma.diningTable.findMany({
      where: { active: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      select: { ...PUBLIC_TABLE, venueId: true },
    });

    return {
      venues: venues.map((venue) => ({
        slug: venue.slug,
        title: venue.customerTitle,
        bigParty: venue.bigParty,
        tables: tables
          .filter((table) => table.venueId === venue.id)
          .map((table) => ({
            code: table.code,
            name: table.name,
            kind: table.kind,
            capacity: table.capacity,
          })),
      })),
    };
  }

  /**
   * `GET /venues/:venue/availability?date=`: each table's state on the date
   * and the date's arrival times. The date defaults to today in Jos; a
   * date before it is refused.
   */
  async availability(
    slug: string,
    date: string | undefined,
  ): Promise<VenueAvailabilityResponse> {
    const now = new Date();
    const today = watToday(now);
    const businessDate = date === undefined ? today : parseIsoDate(date)!;

    if (businessDate.getTime() < today.getTime()) {
      throw new BadRequestException(PAST_DATE_MESSAGE);
    }

    const venue = await this.prisma.venue.findUnique({
      where: { slug },
      select: { id: true, slug: true },
    });

    if (venue === null) throw new NotFoundException(VENUE_NOT_FOUND_MESSAGE);

    const tables = await this.prisma.diningTable.findMany({
      where: { venueId: venue.id, active: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      select: { id: true, code: true },
    });
    const tableIds = tables.map((table) => table.id);
    const sessions = await this.prisma.tableSession.findMany({
      where: { tableId: { in: tableIds }, endedAt: null },
      select: { tableId: true, status: true },
    });
    const booked = await this.prisma.reservation.findMany({
      where: {
        tableId: { in: tableIds },
        businessDate,
        status: { in: HOLDING_STATUSES },
      },
      select: { tableId: true },
    });
    const week = await this.prisma.openingHoursDay.findMany({
      select: {
        dayOfWeek: true,
        isClosed: true,
        opensAtMinutes: true,
        closesAtMinutes: true,
      },
    });
    const settings = await this.prisma.settings.findUniqueOrThrow({
      where: { singleton: true },
      select: { lastArrivalMinutes: true, slotStepMinutes: true },
    });

    const isToday = businessDate.getTime() === today.getTime();
    const bookedIds = new Set(booked.map((row) => row.tableId));

    return {
      venue: venue.slug,
      date: formatIsoDate(businessDate),
      arrivalTimes: arrivalTimes({
        businessDate,
        now,
        hours: hoursOn(week, businessDate),
        settings,
      }),
      tables: tables.map((table) => ({
        code: table.code,
        status: publicTableStatus(
          floorStatus({
            session:
              sessions.find((row) => row.tableId === table.id)?.status ?? null,
            isToday,
            booked: bookedIds.has(table.id),
          }),
        ),
      })),
    };
  }
}
