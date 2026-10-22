import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type Prisma,
  ReservationSource,
  ReservationStatus,
  TableSessionStatus,
} from '../../generated/cnc-client';
import {
  type AuditActor,
  AuditService,
  staffActor,
} from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { formatIsoDate, parseIsoDate } from '../common/calendar-date';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { watToday } from '../common/wat';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { verifiedCustomerId } from './customer-link';
import { ReservationMail } from './reservation-mail';
import { claimVersion } from '../prisma/optimistic-version';
import { drawNumber } from '../prisma/sequences';
import { uniqueViolationTargets } from '../prisma/unique-violation';
import type {
  ChangeReservationRequest,
  CreateReservationRequest,
  ReservationListQuery,
} from './dto/reservation.request';
import type {
  CheckInResponse,
  ReservationPageResponse,
  ReservationResponse,
} from './dto/reception.response';
import {
  ALREADY_RESERVED_MESSAGE,
  CANCEL_CONFIRMED_MESSAGE,
  CANCEL_TIME_MESSAGE,
  CAPACITY_MESSAGE,
  CHANGE_CONFIRMED_MESSAGE,
  CHECKIN_ALLOCATED_MESSAGE,
  CHECKIN_CONFIRMED_MESSAGE,
  CHECKIN_DATE_MESSAGE,
  GUESTS_SEATED_MESSAGE,
  NOSHOW_CONFIRMED_MESSAGE,
  NOSHOW_TIME_MESSAGE,
  RESERVATION_NOT_FOUND_MESSAGE,
  TABLE_LOCKED_MESSAGE,
  TAKEN_ONLINE_MESSAGE,
} from './reception-messages';
import {
  RESERVATION_COLUMNS,
  type TableInfo,
  isTableSessionClash,
  lockTables,
  readReservation,
  readSession,
  readTable,
  reservationResponse,
} from './reception-records';
import {
  HOLDING_STATUSES,
  arrivalProblem,
  bigPartyProblem,
  bookingStart,
  clockMinutes,
  clockText,
  guestPhone,
  initialReminderStamp,
  tableRef,
} from './reservation-rules';

type Tx = Prisma.TransactionClient;

/**
 * One booking as `book` takes it, whatever the channel: Reception now, the
 * website and the app with C6-5 (plan §7.5: "Website, app and Reception
 * all run one command").
 */
export interface BookingInput {
  actor: AuditActor;
  source: ReservationSource;
  /**
   * The signed-in customer (an app booking), or null: the booking then
   * links only to a customer with the same verified email or phone (Q35).
   */
  customerId: string | null;
  name: string;
  phone: string;
  email: string;
  tableId: string;
  businessDate: string;
  time: string;
  party: number;
  note: string;
  ipAddress: string;
}

/**
 * Reservations (plan §4.5, §7.5; card C4-7): `reservation.create`,
 * `checkin`, `cancel`, `noshow` and the new `change`, and Reception's
 * reads.
 *
 * A booking holds its table for the whole date until staff free it (D20,
 * D21): there is no end time and no expiry job. One active booking per
 * table and date is the partial unique index
 * `Reservation_tableId_businessDate_key`; the service checks first so the
 * demo's sentence comes in the demo's order, and maps the index's clash
 * to the same sentence when two bookings race past the check.
 */
@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
    private readonly mail: ReservationMail,
  ) {}

  /**
   * `reservation.create` from Reception, inside the idempotency service's
   * transaction (A9: a retried booking replays the first instead of
   * booking twice).
   */
  create(
    tx: Tx,
    actor: StaffPrincipal,
    request: CreateReservationRequest,
    ipAddress: string,
  ): Promise<ReservationResponse> {
    return this.book(tx, {
      actor: staffActor(actor),
      source: ReservationSource.RECEPTION,
      customerId: null,
      name: request.name,
      phone: request.phone,
      email: request.email,
      tableId: request.tableId,
      businessDate: request.businessDate,
      time: request.time,
      party: request.party,
      note: request.note ?? '',
      ipAddress,
    });
  }

  /**
   * The one booking command, the demo's `reservation.create` in its order
   * after the request's own shape:
   *
   * 1. the table exists and is in use, the party is not a large group for
   *    an online booking (the website's note), and the party fits the
   *    table's places (400);
   * 2. the arrival is in the future, on an open day, within the hours,
   *    and online on the arrival grid (400; `arrivalProblem`);
   * 3. no Confirmed or Checked In booking holds the table that date (409);
   * 4. the table is not Locked (409);
   * 5. for today, no guests are seated at it (409).
   *
   * The table's lock is taken first, so 3 to 5 hold until the commit.
   */
  async book(tx: Tx, input: BookingInput): Promise<ReservationResponse> {
    const now = new Date();
    const businessDate = parseIsoDate(input.businessDate)!;
    const startMinutes = clockMinutes(input.time)!;

    await lockTables(tx, [input.tableId]);

    const table = await this.bookableTable(tx, input.tableId);
    const bigParty = bigPartyProblem(input.source, input.party, table.bigParty);

    if (bigParty !== null) throw new BadRequestException(bigParty);
    if (input.party > table.capacity) {
      throw new BadRequestException(CAPACITY_MESSAGE);
    }

    await this.assertArrival(tx, input.source, businessDate, startMinutes, now);

    const holds = holdMessages(input.source);

    await this.assertTableFree(tx, table.id, businessDate, null, holds, now);

    const phone = guestPhone(input.phone);
    // A signed-in customer's booking is theirs; any other (Reception's, a
    // website guest's) links only to a verified exact match (Q35, A15).
    const customerId =
      input.customerId ?? (await verifiedCustomerId(tx, input.email, phone));
    const number = await drawNumber(tx, 'reservation');

    const row = await insertOrClash(
      () =>
        tx.reservation.create({
          data: {
            number,
            tableId: table.id,
            customerId,
            name: input.name,
            phone,
            email: input.email,
            businessDate,
            startMinutes,
            party: input.party,
            source: input.source,
            note: input.note,
            // Q32: no reminder for a booking made under 24 hours ahead.
            reminderSentAt: initialReminderStamp(
              businessDate,
              startMinutes,
              now,
            ),
          },
          select: RESERVATION_COLUMNS,
        }),
      holds.booked,
    );

    await this.audit.record(
      {
        actor: input.actor,
        action: 'reservation.create',
        ref: number,
        // Which screen a guest booked from; Reception's rows stay as C4
        // wrote them, with the staff member as the actor.
        channel:
          input.source === ReservationSource.RECEPTION ? null : input.source,
        after: {
          table: table.ref,
          businessDate: input.businessDate,
          time: input.time,
          party: input.party,
          name: input.name,
          phone,
          email: input.email,
          // A blank note would read "Note: blank." in the history.
          ...(input.note === '' ? {} : { note: input.note }),
          source: input.source,
        },
        ipAddress: input.ipAddress,
      },
      tx,
    );

    // The confirmation, to the email given whatever the channel (plan
    // §9.2, Q31); sent after the commit by `sendConfirmation`.
    await this.mail.enqueue(tx, 'confirmed', row.id);

    return reservationResponse(row, table);
  }

  /**
   * Send a booking's confirmation once `book`'s transaction has committed.
   * Safe after a replayed create: a sent message is not sent again.
   */
  sendConfirmation(reservationId: string): Promise<void> {
    return this.mail.dispatch(`reservation:${reservationId}:confirmed`);
  }

  /**
   * `reservation.checkin`: a Confirmed booking, on its own date, at a
   * table with no seating or lock, becomes Checked In and opens an
   * Occupied seating for the booked guests (plan §7.5). The table's lock
   * is taken before the booking's version is claimed, as every table
   * command takes them.
   */
  async checkIn(
    actor: StaffPrincipal,
    id: string,
    version: number,
    ipAddress: string,
  ): Promise<CheckInResponse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const row = await this.claim(tx, id, version, true);

        if (row.status !== ReservationStatus.CONFIRMED) {
          throw new ConflictException(CHECKIN_CONFIRMED_MESSAGE);
        }

        if (formatIsoDate(row.businessDate) !== today(now)) {
          throw new ConflictException(CHECKIN_DATE_MESSAGE);
        }

        const seated = await tx.tableSession.findFirst({
          where: { tableId: row.tableId, endedAt: null },
          select: { id: true },
        });

        if (seated !== null) {
          throw new ConflictException(CHECKIN_ALLOCATED_MESSAGE);
        }

        await tx.reservation.update({
          where: { id },
          data: { status: ReservationStatus.CHECKED_IN },
        });

        const session = await tx.tableSession.create({
          data: {
            tableId: row.tableId,
            status: TableSessionStatus.OCCUPIED,
            guest: row.name,
            party: row.party,
            since: now,
            reservationId: id,
            openedById: actor.id,
          },
          select: { id: true },
        });

        await this.audit.record(
          {
            actor: staffActor(actor),
            action: 'reservation.checkin',
            ref: row.number,
            before: { status: ReservationStatus.CONFIRMED },
            after: { status: ReservationStatus.CHECKED_IN },
            ipAddress,
          },
          tx,
        );

        return {
          reservation: await readReservation(tx, id),
          session: await readSession(tx, session.id, now),
        };
      });
    } catch (error) {
      // The table's lock makes the check above decide; the index is the
      // backstop for a seating written by any other path.
      if (isTableSessionClash(error)) {
        throw new ConflictException(CHECKIN_ALLOCATED_MESSAGE);
      }

      throw error;
    }
  }

  /**
   * `reservation.cancel`: a Confirmed booking, before its time, becomes
   * Cancelled and frees the table for the date (plan §7.5). No deposit is
   * taken at launch (D38), so there is nothing to refund.
   */
  async cancel(
    actor: StaffPrincipal,
    id: string,
    version: number,
    ipAddress: string,
  ): Promise<ReservationResponse> {
    let mailKey: string | null = null;
    const response = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const row = await this.claim(tx, id, version, false);

      if (row.status !== ReservationStatus.CONFIRMED) {
        throw new ConflictException(CANCEL_CONFIRMED_MESSAGE);
      }

      if (now >= bookingStart(row.businessDate, row.startMinutes)) {
        throw new ConflictException(CANCEL_TIME_MESSAGE);
      }

      await tx.reservation.update({
        where: { id },
        data: { status: ReservationStatus.CANCELLED, cancelledAt: now },
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'reservation.cancel',
          ref: row.number,
          before: { status: ReservationStatus.CONFIRMED },
          after: { status: ReservationStatus.CANCELLED },
          ipAddress,
        },
        tx,
      );

      mailKey = await this.mail.enqueue(tx, 'cancelled', id);

      return readReservation(tx, id);
    });

    await this.mail.dispatch(mailKey);

    return response;
  }

  /**
   * `reservation.noshow`: a Confirmed booking whose time has passed is
   * marked No Show by staff, which frees the table. A hold never marks
   * itself (D20: no expiry job).
   */
  noShow(
    actor: StaffPrincipal,
    id: string,
    version: number,
    ipAddress: string,
  ): Promise<ReservationResponse> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const row = await this.claim(tx, id, version, false);

      if (row.status !== ReservationStatus.CONFIRMED) {
        throw new ConflictException(NOSHOW_CONFIRMED_MESSAGE);
      }

      if (now <= bookingStart(row.businessDate, row.startMinutes)) {
        throw new ConflictException(NOSHOW_TIME_MESSAGE);
      }

      await tx.reservation.update({
        where: { id },
        data: { status: ReservationStatus.NO_SHOW },
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'reservation.noshow',
          ref: row.number,
          before: { status: ReservationStatus.CONFIRMED },
          after: { status: ReservationStatus.NO_SHOW },
          ipAddress,
        },
        tx,
      );

      return readReservation(tx, id);
    });
  }

  /**
   * `reservation.change` (new; plan §16): Reception's "Change booking". A
   * Confirmed booking's guest, contact, note, party, table, date or time;
   * only the fields sent change. What the change touches is checked again
   * as a new booking would be: the places when the table or party
   * changes, the arrival (Reception's rules, Q30) when the date or time
   * changes, and the table's holds when the table or date changes. Both
   * tables' locks are taken, in id order.
   */
  async change(
    actor: StaffPrincipal,
    id: string,
    request: ChangeReservationRequest,
    ipAddress: string,
  ): Promise<ReservationResponse> {
    let mailKey: string | null = null;
    const response = await insertOrClash(
      () =>
        this.prisma.$transaction(async (tx) => {
          const now = new Date();
          const found = await tx.reservation.findUnique({
            where: { id },
            select: { tableId: true },
          });

          if (found === null) {
            throw new NotFoundException(RESERVATION_NOT_FOUND_MESSAGE);
          }

          await lockTables(tx, [
            found.tableId,
            request.tableId ?? found.tableId,
          ]);

          const row = await this.claim(tx, id, request.version, false);

          if (row.status !== ReservationStatus.CONFIRMED) {
            throw new ConflictException(CHANGE_CONFIRMED_MESSAGE);
          }

          const before = {
            tableId: row.tableId,
            businessDate: formatIsoDate(row.businessDate),
            startMinutes: row.startMinutes,
            party: row.party,
            name: row.name,
            phone: row.phone,
            email: row.email,
            note: row.note,
          };
          const next = {
            tableId: request.tableId ?? before.tableId,
            businessDate: request.businessDate ?? before.businessDate,
            startMinutes:
              request.time === undefined
                ? before.startMinutes
                : clockMinutes(request.time)!,
            party: request.party ?? before.party,
            name: request.name ?? before.name,
            phone:
              request.phone === undefined
                ? before.phone
                : guestPhone(request.phone),
            email: request.email ?? before.email,
            note: request.note ?? before.note,
          };
          const tableMoved = next.tableId !== before.tableId;
          const dateMoved = next.businessDate !== before.businessDate;
          const nextDate = parseIsoDate(next.businessDate)!;
          let table = await readTable(tx, next.tableId);

          if (tableMoved || next.party !== before.party) {
            table = await this.bookableTable(tx, next.tableId);

            if (next.party > table.capacity) {
              throw new BadRequestException(CAPACITY_MESSAGE);
            }
          }

          if (dateMoved || next.startMinutes !== before.startMinutes) {
            await this.assertArrival(
              tx,
              ReservationSource.RECEPTION,
              nextDate,
              next.startMinutes,
              now,
            );
          }

          if (tableMoved || dateMoved) {
            await this.assertTableFree(
              tx,
              next.tableId,
              nextDate,
              id,
              holdMessages(ReservationSource.RECEPTION),
              now,
            );
          }

          const contactChanged =
            next.email !== before.email || next.phone !== before.phone;
          const customerId =
            row.customerId === null && contactChanged
              ? await verifiedCustomerId(tx, next.email, next.phone)
              : row.customerId;

          await tx.reservation.update({
            where: { id },
            data: {
              tableId: next.tableId,
              businessDate: nextDate,
              startMinutes: next.startMinutes,
              party: next.party,
              name: next.name,
              phone: next.phone,
              email: next.email,
              note: next.note,
              customerId,
              // A new date or time gets its own reminder (Q32), unless it
              // is already under 24 hours away.
              ...(dateMoved || next.startMinutes !== before.startMinutes
                ? {
                    reminderSentAt: initialReminderStamp(
                      nextDate,
                      next.startMinutes,
                      now,
                    ),
                  }
                : {}),
            },
          });

          const previousTable = tableMoved
            ? await readTable(tx, before.tableId)
            : table;

          await this.audit.record(
            {
              actor: staffActor(actor),
              action: 'reservation.change',
              ref: row.number,
              ...changedFields(
                {
                  ...before,
                  table: previousTable!.ref,
                  time: clockText(before.startMinutes),
                },
                {
                  ...next,
                  table: table!.ref,
                  time: clockText(next.startMinutes),
                },
              ),
              ipAddress,
            },
            tx,
          );

          // The guest hears of a change to what they will find on arrival:
          // the table, the date, the time or the party (plan §9.2).
          if (
            tableMoved ||
            dateMoved ||
            next.startMinutes !== before.startMinutes ||
            next.party !== before.party
          ) {
            mailKey = await this.mail.enqueue(tx, 'changed', id);
          }

          return readReservation(tx, id);
        }),
      ALREADY_RESERVED_MESSAGE,
    );

    await this.mail.dispatch(mailKey);

    return response;
  }

  /** `GET /staff/reservations`: one date's bookings (today by default), or every date's. */
  async list(query: ReservationListQuery): Promise<ReservationPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.ReservationWhereInput = {};

    if (query.all !== 'true') {
      where.businessDate = parseIsoDate(query.date ?? today(new Date()))!;
    }

    const q = query.q?.trim() ?? '';

    if (q !== '') {
      // A phone is searched as stored: without spaces or dashes, and a
      // whole Nigerian number in its one form, however it was typed.
      const phone = guestPhone(q.replace(/[\s-]/g, '')) || q;

      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { number: { contains: q, mode: 'insensitive' } },
        { phone: { contains: phone } },
      ];
    }

    const rows = await this.prisma.reservation.findMany({
      where,
      orderBy: [
        { businessDate: 'asc' },
        { startMinutes: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        ...RESERVATION_COLUMNS,
        table: {
          select: {
            code: true,
            name: true,
            venue: { select: { slug: true, staffName: true } },
          },
        },
      },
    });
    const total = await this.prisma.reservation.count({ where });

    return {
      data: rows.map(({ table, ...row }) =>
        reservationResponse(row, {
          ref: tableRef(table.venue.staffName, table.code),
          name: table.name,
          venueSlug: table.venue.slug,
          venueName: table.venue.staffName,
        }),
      ),
      page,
      pageSize,
      total,
    };
  }

  /** `GET /staff/reservations/:id`. */
  async detail(id: string): Promise<ReservationResponse> {
    const found = await this.prisma.reservation.findUnique({
      where: { id },
      select: { id: true },
    });

    if (found === null) {
      throw new NotFoundException(RESERVATION_NOT_FOUND_MESSAGE);
    }

    return readReservation(this.prisma, id);
  }

  /**
   * Claim a booking's `version` (A8), which locks it for the rest of the
   * transaction, and read it. With `lockTable`, the booking's table lock
   * is taken first (every table command takes its table's lock before any
   * row): the table is read before the claim, and a booking moved to
   * another table in between has moved its version, so the claim refuses.
   */
  async claim(tx: Tx, id: string, version: number, lockTable: boolean) {
    if (lockTable) {
      const found = await tx.reservation.findUnique({
        where: { id },
        select: { tableId: true },
      });

      if (found === null) {
        throw new NotFoundException(RESERVATION_NOT_FOUND_MESSAGE);
      }

      await lockTables(tx, [found.tableId]);
    }

    await claimVersion(tx, {
      table: 'Reservation',
      id,
      version,
      notFound: RESERVATION_NOT_FOUND_MESSAGE,
    });

    return tx.reservation.findUniqueOrThrow({
      where: { id },
      select: RESERVATION_COLUMNS,
    });
  }

  /** A table that exists and is in use, else the demo's capacity sentence (400). */
  async bookableTable(tx: Tx, id: string): Promise<TableInfo> {
    const table = await readTable(tx, id);

    if (table === null || !table.active) {
      throw new BadRequestException(CAPACITY_MESSAGE);
    }

    return table;
  }

  /** The arrival rules for the date's opening hours and the timing settings (400). */
  private async assertArrival(
    tx: Tx,
    source: ReservationSource,
    businessDate: Date,
    startMinutes: number,
    now: Date,
  ): Promise<void> {
    const problem = await this.arrivalProblemOn(
      tx,
      source,
      businessDate,
      startMinutes,
      now,
    );

    if (problem !== null) throw new BadRequestException(problem);
  }

  /**
   * `arrivalProblem` for the date's opening hours and the timing settings:
   * the sentence that refuses the arrival, or null. Public for the
   * customer's change, which answers in the account app's words.
   */
  async arrivalProblemOn(
    tx: Tx,
    source: ReservationSource,
    businessDate: Date,
    startMinutes: number,
    now: Date,
  ): Promise<string | null> {
    const hours = await tx.openingHoursDay.findUnique({
      where: { dayOfWeek: businessDate.getUTCDay() },
      select: { isClosed: true, opensAtMinutes: true, closesAtMinutes: true },
    });
    const settings = await tx.settings.findUniqueOrThrow({
      where: { singleton: true },
      select: { lastArrivalMinutes: true, slotStepMinutes: true },
    });
    return arrivalProblem({
      source,
      businessDate,
      startMinutes,
      now,
      // A day with no row has no hours: closed.
      hours: hours ?? {
        isClosed: true,
        opensAtMinutes: null,
        closesAtMinutes: null,
      },
      settings,
    });
  }

  /**
   * The demo's three holds on a table for a date, in its order: another
   * Confirmed or Checked In booking that date, a Locked seating, and for
   * today, guests seated now (409 each, in `holds`' words). `except` is the
   * booking being changed.
   */
  async assertTableFree(
    tx: Tx,
    tableId: string,
    businessDate: Date,
    except: string | null,
    holds: TableHoldMessages,
    now: Date,
  ): Promise<void> {
    const booked = await tx.reservation.findFirst({
      where: {
        tableId,
        businessDate,
        status: { in: HOLDING_STATUSES },
        ...(except === null ? {} : { id: { not: except } }),
      },
      select: { id: true },
    });

    if (booked !== null) throw new ConflictException(holds.booked);

    const session = await tx.tableSession.findFirst({
      where: { tableId, endedAt: null },
      select: { status: true },
    });

    if (session?.status === TableSessionStatus.LOCKED) {
      throw new ConflictException(holds.locked);
    }

    if (
      session?.status === TableSessionStatus.OCCUPIED &&
      formatIsoDate(businessDate) === today(now)
    ) {
      throw new ConflictException(holds.seated);
    }
  }
}

/** Today in Jos, `YYYY-MM-DD`. */
function today(now: Date): string {
  return formatIsoDate(watToday(now));
}

/**
 * The sentences for the three holds on a table (409), in the words of
 * whoever is asking. Reception is told which hold it is, in the demo's
 * words. A website or app guest is told only that the place has just
 * been taken (the website's own sentence): why a table is locked, or that
 * guests are seated at it, is staff knowledge, and the floor plan the
 * guest saw showed the table free, so the answer is the same race.
 */
export interface TableHoldMessages {
  booked: string;
  locked: string;
  seated: string;
}

export function holdMessages(source: ReservationSource): TableHoldMessages {
  return source === ReservationSource.RECEPTION
    ? {
        booked: ALREADY_RESERVED_MESSAGE,
        locked: TABLE_LOCKED_MESSAGE,
        seated: GUESTS_SEATED_MESSAGE,
      }
    : {
        booked: TAKEN_ONLINE_MESSAGE,
        locked: TAKEN_ONLINE_MESSAGE,
        seated: TAKEN_ONLINE_MESSAGE,
      };
}

/**
 * Run a write that may meet the one-active-booking index, and answer its
 * clash with the domain's sentence (409) rather than a 500. The index is
 * what decides a race between two bookings (*Data and migrations*); it is
 * read by its fields through `uniqueViolationTargets`. Shared with the
 * customer's change (`CustomerReservationsService`).
 */
export async function insertOrClash<T>(
  write: () => Promise<T>,
  clash: string | (() => string),
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const targets = uniqueViolationTargets(error);

    if (targets.includes('tableId') && targets.includes('businessDate')) {
      throw new ConflictException(typeof clash === 'string' ? clash : clash());
    }

    throw error;
  }
}

/**
 * The fields a change touched, as the audit row's `before` and `after`,
 * so the history reads "Party changed from 2 to 3." for each and nothing
 * for the rest. Ids and minutes are left to their readable twins (the
 * table's ref, the time).
 */
function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const shown = [
    'table',
    'businessDate',
    'time',
    'party',
    'name',
    'phone',
    'email',
    'note',
  ];
  const out = {
    before: {} as Record<string, unknown>,
    after: {} as Record<string, unknown>,
  };

  for (const key of shown) {
    if (before[key] !== after[key]) {
      out.before[key] = before[key];
      out.after[key] = after[key];
    }
  }

  return out;
}
