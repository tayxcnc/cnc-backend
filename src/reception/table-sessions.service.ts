import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Department,
  type Prisma,
  ReservationStatus,
  StaffRole,
  TableSessionStatus,
} from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { ROLE_REFUSED_MESSAGE, isManager } from '../auth/staff-roles';
import { formatIsoDate, parseIsoDate } from '../common/calendar-date';
import { watToday } from '../common/wat';
import { UNSETTLED_ORDER_STATUSES } from '../orders/order-rules';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import type {
  FloorResponse,
  FloorTableResponse,
  TableReleaseResponse,
  TableSessionResponse,
} from './dto/reception.response';
import type {
  AllocateTableRequest,
  FloorQuery,
  ReleaseTableRequest,
} from './dto/table.request';
import {
  type StaffBellItem,
  freeTableReminderItem,
} from './free-table-reminder';
import {
  ALREADY_ALLOCATED_MESSAGE,
  LOCK_REASON_MESSAGE,
  NO_ALLOCATION_MESSAGE,
  SEAT_GUESTS_MESSAGE,
  TABLE_NOT_FOUND_MESSAGE,
  TABLE_RESERVED_MESSAGE,
  UNSETTLED_ORDERS_MESSAGE,
  VENUE_MESSAGE,
} from './reception-messages';
import {
  SESSION_COLUMNS,
  type TableInfo,
  isTableSessionClash,
  lockTables,
  readSession,
  readTable,
  sessionResponse,
} from './reception-records';
import {
  HOLDING_STATUSES,
  clockText,
  floorStatus,
  tableRef,
} from './reservation-rules';

type Tx = Prisma.TransactionClient;

/**
 * Table sessions (plan §4.5, §7.5; card C4-7): `table.allocate` (seat
 * walk-in guests, or lock a table), `table.release`, Reception's floor
 * read, and the Free Table Reminder.
 *
 * A table holds at most one open seating, by the partial unique index
 * `TableSession_tableId_key`. Every command here takes the table's
 * advisory lock first (`lockTables`), as the booking commands do, so the
 * demo's checks across bookings and seatings hold until the commit.
 * Nothing ends a seating by itself (D20): the reminder only asks.
 */
@Injectable()
export class TableSessionsService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `table.allocate`, the demo's checks in its order after the request's
   * shape (the status is the request's):
   *
   * 1. the table exists and is in use (404);
   * 2. it has no open seating or lock (409);
   * 3. no Confirmed booking holds it today (409; check the guests in, or
   *    resolve the booking, instead);
   * 4. Occupied: a guest and a party from 1 to the table's places; Locked:
   *    a reason (400).
   */
  async allocate(
    actor: StaffPrincipal,
    tableId: string,
    request: AllocateTableRequest,
    ipAddress: string,
  ): Promise<TableSessionResponse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();

        await lockTables(tx, [tableId]);

        const table = await this.usableTable(tx, tableId);
        const open = await tx.tableSession.findFirst({
          where: { tableId, endedAt: null },
          select: { id: true },
        });

        if (open !== null)
          throw new ConflictException(ALREADY_ALLOCATED_MESSAGE);

        const booked = await tx.reservation.findFirst({
          where: {
            tableId,
            businessDate: watToday(now),
            status: ReservationStatus.CONFIRMED,
          },
          select: { id: true },
        });

        if (booked !== null)
          throw new ConflictException(TABLE_RESERVED_MESSAGE);

        const occupied = request.status === TableSessionStatus.OCCUPIED;
        const guest = request.guest ?? '';
        const party = request.party ?? 0;
        const note = request.note ?? '';

        if (occupied && (guest === '' || party < 1 || party > table.capacity)) {
          throw new BadRequestException(SEAT_GUESTS_MESSAGE);
        }

        if (!occupied && note === '') {
          throw new BadRequestException(LOCK_REASON_MESSAGE);
        }

        const session = await tx.tableSession.create({
          data: {
            tableId,
            status: request.status,
            guest: occupied ? guest : '',
            party: occupied ? party : 0,
            note: occupied ? '' : note,
            since: now,
            openedById: actor.id,
          },
          select: { id: true },
        });

        await this.audit.record(
          {
            actor: staffActor(actor),
            action: 'table.allocate',
            ref: table.ref,
            after: occupied
              ? { status: request.status, guest, party }
              : { status: request.status, note },
            ipAddress,
          },
          tx,
        );

        return readSession(tx, session.id, now);
      });
    } catch (error) {
      // Two allocations of one table at once: the table's lock makes the
      // check decide, and the index is the backstop for any other path.
      if (isTableSessionClash(error)) {
        throw new ConflictException(ALREADY_ALLOCATED_MESSAGE);
      }

      throw error;
    }
  }

  /**
   * `table.release`: end the named seating, refused while any bill on the
   * table is Open or awaiting payment, of any date (plan §7.1 step 6), and
   * complete the table's Checked In bookings (plan §7.5: "Release
   * completes the booking").
   */
  release(
    actor: StaffPrincipal,
    tableId: string,
    request: ReleaseTableRequest,
    ipAddress: string,
  ): Promise<TableReleaseResponse> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();

      await lockTables(tx, [tableId]);

      const table = await readTable(tx, tableId);

      if (table === null) throw new NotFoundException(TABLE_NOT_FOUND_MESSAGE);

      const open = await tx.tableSession.findFirst({
        where: { id: request.sessionId, tableId, endedAt: null },
        select: { id: true },
      });

      if (open === null) throw new ConflictException(NO_ALLOCATION_MESSAGE);

      await claimVersion(tx, {
        table: 'TableSession',
        id: open.id,
        version: request.version,
        notFound: NO_ALLOCATION_MESSAGE,
      });

      const session = await tx.tableSession.findUniqueOrThrow({
        where: { id: open.id },
        select: SESSION_COLUMNS,
      });
      const unsettled = await tx.order.count({
        where: { tableId, status: { in: UNSETTLED_ORDER_STATUSES } },
      });

      if (unsettled > 0) throw new ConflictException(UNSETTLED_ORDERS_MESSAGE);

      await tx.tableSession.update({
        where: { id: open.id },
        data: { endedAt: now, closedById: actor.id },
      });

      const seated = await tx.reservation.findMany({
        where: { tableId, status: ReservationStatus.CHECKED_IN },
        orderBy: { id: 'asc' },
        select: { id: true, number: true },
      });

      // A booking another device holds is now Completed under it: its
      // version moves, so that device's next write is told to refresh.
      for (const booking of seated) {
        await tx.reservation.update({
          where: { id: booking.id },
          data: {
            status: ReservationStatus.COMPLETED,
            version: { increment: 1 },
          },
        });
      }

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'table.release',
          ref: table.ref,
          before:
            session.status === TableSessionStatus.OCCUPIED
              ? {
                  status: session.status,
                  guest: session.guest,
                  party: session.party,
                }
              : { status: session.status, note: session.note },
          after: { status: 'Available' },
          ipAddress,
        },
        tx,
      );

      return {
        session: await readSession(tx, open.id, now),
        completedReservations: seated.map((booking) => booking.number),
      };
    });
  }

  /**
   * `GET /staff/floor?venue&date` (plan §5.4, §6.1): every table in use,
   * with its status for the date, its open seating or lock, the date's
   * Confirmed and Checked In bookings, and its unsettled bills of any
   * date.
   *
   * Reception and managers read any date with the guests' contacts. The
   * Point of Sale roles read today only, without a phone or an email, and
   * a Bartender sees Bar bills only.
   */
  async floor(
    actor: StaffPrincipal,
    query: FloorQuery,
  ): Promise<FloorResponse> {
    const now = new Date();
    const today = formatIsoDate(watToday(now));
    const date = query.date ?? today;
    const reception =
      isManager(actor.role) || actor.role === StaffRole.RECEPTION;

    if (!reception && date !== today) {
      throw new ForbiddenException(ROLE_REFUSED_MESSAGE);
    }

    let venueId: string | undefined;

    if (query.venue !== undefined) {
      const venue = await this.prisma.venue.findUnique({
        where: { slug: query.venue },
        select: { id: true },
      });

      if (venue === null) throw new BadRequestException(VENUE_MESSAGE);

      venueId = venue.id;
    }

    const venues = await this.prisma.venue.findMany({
      where: venueId === undefined ? {} : { id: venueId },
      orderBy: [{ sort: 'asc' }, { slug: 'asc' }],
      select: { id: true, slug: true, staffName: true },
    });
    const tables = await this.prisma.diningTable.findMany({
      where: { venueId: { in: venues.map((venue) => venue.id) }, active: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        venueId: true,
        code: true,
        name: true,
        kind: true,
        capacity: true,
      },
    });
    const tableIds = tables.map((table) => table.id);
    const sessions = await this.prisma.tableSession.findMany({
      where: { tableId: { in: tableIds }, endedAt: null },
      select: { ...SESSION_COLUMNS, openedBy: { select: { name: true } } },
    });
    const bookings = await this.prisma.reservation.findMany({
      where: {
        tableId: { in: tableIds },
        businessDate: parseIsoDate(date)!,
        status: { in: HOLDING_STATUSES },
      },
      orderBy: [{ startMinutes: 'asc' }, { createdAt: 'asc' }],
    });
    const orders = await this.prisma.order.findMany({
      where: {
        tableId: { in: tableIds },
        status: { in: UNSETTLED_ORDER_STATUSES },
        ...(actor.role === StaffRole.BARTENDER
          ? { department: Department.BAR }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        number: true,
        tableId: true,
        department: true,
        businessDate: true,
        status: true,
      },
    });
    const { freeTableReminderMinutes } =
      await this.prisma.settings.findUniqueOrThrow({
        where: { singleton: true },
        select: { freeTableReminderMinutes: true },
      });
    const venueById = new Map(venues.map((venue) => [venue.id, venue]));
    const ordered = [...tables].sort(
      (a, b) =>
        venues.indexOf(venueById.get(a.venueId)!) -
        venues.indexOf(venueById.get(b.venueId)!),
    );

    const rows: FloorTableResponse[] = ordered.map((table) => {
      const venue = venueById.get(table.venueId)!;
      const ref = tableRef(venue.staffName, table.code);
      const session = sessions.find((row) => row.tableId === table.id) ?? null;
      const held = bookings.filter((row) => row.tableId === table.id);

      return {
        id: table.id,
        ref,
        code: table.code,
        name: table.name,
        kind: table.kind,
        capacity: table.capacity,
        venueSlug: venue.slug,
        venueName: venue.staffName,
        status: floorStatus({
          session: session?.status ?? null,
          isToday: date === today,
          booked: held.length > 0,
        }),
        session:
          session === null
            ? null
            : sessionResponse(
                session,
                { ref, name: table.name },
                session.openedBy.name,
                freeTableReminderMinutes,
                now,
              ),
        reservations: held.map((row) => ({
          id: row.id,
          number: row.number,
          name: row.name,
          phone: reception ? row.phone : null,
          email: reception ? row.email : null,
          time: clockText(row.startMinutes),
          party: row.party,
          status: row.status,
          note: row.note,
          depositKobo: row.depositKobo,
          depositUsedKobo: row.depositUsedKobo,
          version: row.version,
        })),
        orders: orders
          .filter((row) => row.tableId === table.id)
          .map((row) => ({
            id: row.id,
            number: row.number,
            department: row.department,
            businessDate: formatIsoDate(row.businessDate),
            status: row.status,
          })),
      };
    });

    return { businessDate: date, freeTableReminderMinutes, tables: rows };
  }

  /**
   * The Free Table Reminder items due now (plan §9.1): every open Occupied
   * seating at least `freeTableReminderMinutes` old, oldest first. For the
   * bell of Reception and managers; no alert switch, as in the demo.
   */
  async freeTableReminders(now: Date): Promise<StaffBellItem[]> {
    const { freeTableReminderMinutes } =
      await this.prisma.settings.findUniqueOrThrow({
        where: { singleton: true },
        select: { freeTableReminderMinutes: true },
      });
    const cutoff = new Date(now.getTime() - freeTableReminderMinutes * 60_000);
    const due = await this.prisma.tableSession.findMany({
      where: {
        status: TableSessionStatus.OCCUPIED,
        endedAt: null,
        since: { lte: cutoff },
      },
      orderBy: [{ since: 'asc' }, { id: 'asc' }],
      select: {
        tableId: true,
        guest: true,
        since: true,
        table: { select: { name: true } },
      },
    });

    return due.map((row) =>
      freeTableReminderItem(
        {
          tableId: row.tableId,
          tableName: row.table.name,
          guest: row.guest,
          since: row.since,
        },
        now,
      ),
    );
  }

  /** A table that exists and is in use, else "Table not found." (404). */
  private async usableTable(tx: Tx, id: string): Promise<TableInfo> {
    const table = await readTable(tx, id);

    if (table === null || !table.active) {
      throw new NotFoundException(TABLE_NOT_FOUND_MESSAGE);
    }

    return table;
  }
}
