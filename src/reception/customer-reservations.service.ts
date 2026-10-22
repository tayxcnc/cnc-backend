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
} from '../../generated/cnc-client';
import type { AuditActor } from '../audit/audit.service';
import { AuditService } from '../audit/audit.service';
import type { CustomerPrincipal } from '../auth/customer-principal';
import { formatIsoDate, parseIsoDate } from '../common/calendar-date';
import { hashClientAddress } from '../common/client-address';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type PaginationQuery,
} from '../common/dto/pagination.query';
import { customerPhone } from '../customers/profile-rules';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import type {
  CustomerReservationChangeRequest,
  CustomerReservationPageResponse,
  CustomerReservationResponse,
  WebReservationRequest,
} from './dto/customer-reservation.dto';
import {
  CANCEL_CONFIRMED_MESSAGE,
  CAPACITY_MESSAGE,
  CHANGE_CONFIRMED_MESSAGE,
  CLOSED_DAY_MESSAGE,
  CUSTOMER_ARRIVAL_MESSAGE,
  CUSTOMER_RESERVATION_NOT_FOUND_MESSAGE,
  LATE_CHANGE_MESSAGE,
  customerCapacityMessage,
  customerTakenMessage,
} from './reception-messages';
import { assertOnlineBookingCaps } from './booking-throttle';
import { lockTables } from './reception-records';
import { ReservationMail } from './reservation-mail';
import {
  bigPartyProblem,
  bookingStart,
  changeableUntil,
  clockMinutes,
  clockText,
  initialReminderStamp,
  insideChangeWindow,
} from './reservation-rules';
import { ReservationsService, insertOrClash } from './reservations.service';

type Tx = Prisma.TransactionClient;

/** The columns a guest's view of a booking is built from. */
const CUSTOMER_COLUMNS = {
  id: true,
  number: true,
  tableId: true,
  customerId: true,
  name: true,
  businessDate: true,
  startMinutes: true,
  party: true,
  status: true,
  source: true,
  // The guest's own note, never Reception's (`note`): staff write that for
  // each other, and Q35 links phone bookings to accounts.
  guestNote: true,
  cancelledAt: true,
  createdAt: true,
  version: true,
} satisfies Prisma.ReservationSelect;

type CustomerRow = Prisma.ReservationGetPayload<{
  select: typeof CUSTOMER_COLUMNS;
}>;

/** A table as the guest's booking names it. */
interface GuestTable {
  code: string;
  name: string;
  capacity: number;
  active: boolean;
  venue: string;
  venueTitle: string;
  bigParty: number;
}

/**
 * The guest's side of bookings (plan §5.1, §5.2; cards C6-5 and C6-6):
 *
 * - `book`: the website's and the app's `POST /reservations`, through
 *   Reception's one booking command (`ReservationsService.book`), so the
 *   same lock, checks and partial unique index decide every channel;
 * - `list`, `change`, `cancel`: the signed-in customer's own bookings,
 *   and only theirs (`customerId`), with the 24-hour rule (Q6) enforced
 *   here, not trusted to the app.
 */
@Injectable()
export class CustomerReservationsService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
    private readonly reservations: ReservationsService,
    private readonly mail: ReservationMail,
  ) {}

  /**
   * `POST /reservations`, inside the idempotency service's transaction.
   * Signed in, the booking is the app's (`APP`) and the customer's own;
   * otherwise it is the website's (`WEB`), made by a guest, and links to a
   * customer only on a verified exact match (Q35, A15).
   */
  async book(
    tx: Tx,
    customer: CustomerPrincipal | null,
    request: WebReservationRequest,
    ipAddress: string,
  ): Promise<CustomerReservationResponse> {
    const table = await tx.diningTable.findFirst({
      where: { code: request.table, venue: { slug: request.venue } },
      select: { id: true },
    });

    // A room or table that does not exist is the command's own answer to
    // "no such table" (400), not a 404: the path names no record.
    if (table === null) throw new BadRequestException(CAPACITY_MESSAGE);

    // The stored caps, before the command takes the table's lock: a script
    // must not hold the floor or fill an inbox from one address.
    const ipHash = hashClientAddress(ipAddress);

    await assertOnlineBookingCaps(
      tx,
      { ipHash, email: request.email },
      new Date(),
    );

    const actor: AuditActor =
      customer === null
        ? { kind: 'SYSTEM', name: `Website guest ${request.name}` }
        : {
            kind: 'CUSTOMER',
            customerId: customer.id,
            name: await this.customerName(tx, customer.id, request.name),
          };
    const made = await this.reservations.book(tx, {
      actor,
      source: customer === null ? ReservationSource.WEB : ReservationSource.APP,
      customerId: customer?.id ?? null,
      name: request.name,
      phone: customerPhone(request.phone)!,
      email: request.email,
      tableId: table.id,
      businessDate: request.businessDate,
      time: request.time,
      party: request.party,
      note: request.note ?? '',
      ipAddress,
      ipHash,
    });

    return this.read(tx, made.id, new Date());
  }

  /** Send the confirmation once `book`'s transaction has committed. */
  sendConfirmation(reservationId: string): Promise<void> {
    return this.reservations.sendConfirmation(reservationId);
  }

  /**
   * `GET /me/reservations`: the customer's bookings, latest date and
   * arrival first, as the account app lists them.
   */
  async list(
    customerId: string,
    query: PaginationQuery,
  ): Promise<CustomerReservationPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where = { customerId };
    const rows = await this.prisma.reservation.findMany({
      where,
      orderBy: [
        { businessDate: 'desc' },
        { startMinutes: 'desc' },
        { createdAt: 'desc' },
        { id: 'asc' },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: CUSTOMER_COLUMNS,
    });
    const total = await this.prisma.reservation.count({ where });
    const tables = await this.tables(
      this.prisma,
      rows.map((row) => row.tableId),
    );
    const now = new Date();

    return {
      data: rows.map((row) =>
        customerReservation(row, tables.get(row.tableId)!, now),
      ),
      page,
      pageSize,
      total,
    };
  }

  /**
   * `PATCH /me/reservations/:id` (C6-6): the date, the arrival or the party
   * of the customer's own Confirmed booking, at least 24 hours before it
   * starts (Q6). The table stays. In order:
   *
   * 1. the booking is the customer's (404 otherwise, one sentence for
   *    "not yours" and "none");
   * 2. its version is current (409), taken with the table's lock;
   * 3. it is Confirmed (409) and at least 24 hours away (409, the app's
   *    words);
   * 4. a new party fits: the online large-party rule, then the table's
   *    places (400);
   * 5. a new date or time is one the website offers (400);
   * 6. on a new date, the table is free (409), the index deciding a race.
   */
  async change(
    customer: CustomerPrincipal,
    id: string,
    request: CustomerReservationChangeRequest,
    ipAddress: string,
  ): Promise<CustomerReservationResponse> {
    let mailKey: string | null = null;
    let takenMessage = '';

    const response = await insertOrClash(
      () =>
        this.prisma.$transaction(async (tx) => {
          const now = new Date();
          const row = await this.claimOwn(tx, customer.id, id, request.version);
          const table = (await this.tables(tx, [row.tableId])).get(
            row.tableId,
          )!;

          takenMessage = customerTakenMessage(table.name);

          if (row.status !== ReservationStatus.CONFIRMED) {
            throw new ConflictException(CHANGE_CONFIRMED_MESSAGE);
          }

          if (insideChangeWindow(row.businessDate, row.startMinutes, now)) {
            throw new ConflictException(LATE_CHANGE_MESSAGE);
          }

          const before = {
            businessDate: formatIsoDate(row.businessDate),
            startMinutes: row.startMinutes,
            party: row.party,
          };
          const next = {
            businessDate: request.businessDate ?? before.businessDate,
            startMinutes:
              request.time === undefined
                ? before.startMinutes
                : clockMinutes(request.time)!,
            party: request.party ?? before.party,
          };
          const nextDate = parseIsoDate(next.businessDate)!;
          const dateMoved = next.businessDate !== before.businessDate;
          const online =
            row.source === ReservationSource.RECEPTION
              ? ReservationSource.APP
              : row.source;

          if (next.party !== before.party) {
            const big = bigPartyProblem(online, next.party, table.bigParty);

            if (big !== null) throw new BadRequestException(big);

            if (!table.active || next.party > table.capacity) {
              throw new BadRequestException(
                customerCapacityMessage(table.name, table.capacity),
              );
            }
          }

          if (dateMoved || next.startMinutes !== before.startMinutes) {
            const problem = await this.reservations.arrivalProblemOn(
              tx,
              online,
              nextDate,
              next.startMinutes,
              now,
            );

            if (problem !== null) {
              throw new BadRequestException(
                problem === CLOSED_DAY_MESSAGE
                  ? CLOSED_DAY_MESSAGE
                  : CUSTOMER_ARRIVAL_MESSAGE,
              );
            }
          }

          if (dateMoved) {
            await this.reservations.assertTableFree(
              tx,
              row.tableId,
              nextDate,
              id,
              {
                booked: takenMessage,
                locked: takenMessage,
                seated: takenMessage,
              },
              now,
            );
          }

          const changed = {
            before: {} as Record<string, unknown>,
            after: {} as Record<string, unknown>,
          };

          if (dateMoved) {
            changed.before.businessDate = before.businessDate;
            changed.after.businessDate = next.businessDate;
          }

          if (next.startMinutes !== before.startMinutes) {
            changed.before.time = clockText(before.startMinutes);
            changed.after.time = clockText(next.startMinutes);
          }

          if (next.party !== before.party) {
            changed.before.party = before.party;
            changed.after.party = next.party;
          }

          await tx.reservation.update({
            where: { id },
            data: {
              businessDate: nextDate,
              startMinutes: next.startMinutes,
              party: next.party,
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

          await this.audit.record(
            {
              actor: {
                kind: 'CUSTOMER',
                customerId: customer.id,
                name: await this.customerName(tx, customer.id, row.name),
              },
              action: 'reservation.change',
              ref: row.number,
              ...changed,
              channel: ReservationSource.APP,
              ipAddress,
            },
            tx,
          );

          if (Object.keys(changed.after).length > 0) {
            mailKey = await this.mail.enqueue(tx, 'changed', id);
          }

          return this.read(tx, id, now);
        }),
      // The index met by a race past the check above: the app's sentence,
      // read once the table's name is known (the clash comes after it).
      () => takenMessage,
    );

    await this.mail.dispatch(mailKey);

    return response;
  }

  /**
   * `POST /me/reservations/:id/cancel` (C6-6): the customer's own Confirmed
   * booking, at least 24 hours before it starts (Q6), becomes Cancelled and
   * frees its table.
   */
  async cancel(
    customer: CustomerPrincipal,
    id: string,
    version: number,
    ipAddress: string,
  ): Promise<CustomerReservationResponse> {
    let mailKey: string | null = null;

    const response = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const row = await this.claimOwn(tx, customer.id, id, version);

      if (row.status !== ReservationStatus.CONFIRMED) {
        throw new ConflictException(CANCEL_CONFIRMED_MESSAGE);
      }

      if (insideChangeWindow(row.businessDate, row.startMinutes, now)) {
        throw new ConflictException(LATE_CHANGE_MESSAGE);
      }

      await tx.reservation.update({
        where: { id },
        data: { status: ReservationStatus.CANCELLED, cancelledAt: now },
      });

      await this.audit.record(
        {
          actor: {
            kind: 'CUSTOMER',
            customerId: customer.id,
            name: await this.customerName(tx, customer.id, row.name),
          },
          action: 'reservation.cancel',
          ref: row.number,
          before: { status: ReservationStatus.CONFIRMED },
          after: { status: ReservationStatus.CANCELLED },
          channel: ReservationSource.APP,
          ipAddress,
        },
        tx,
      );

      mailKey = await this.mail.enqueue(tx, 'cancelled', id);

      return this.read(tx, id, now);
    });

    await this.mail.dispatch(mailKey);

    return response;
  }

  /**
   * The customer's own booking, its table's lock taken and its version
   * claimed (A8), then read. A booking that is someone else's, or none, is
   * the app's one not-found sentence (404), checked before the claim so a
   * stranger's id never moves its version.
   */
  private async claimOwn(
    tx: Tx,
    customerId: string,
    id: string,
    version: number,
  ): Promise<CustomerRow> {
    const found = await tx.reservation.findFirst({
      where: { id, customerId },
      select: { tableId: true },
    });

    if (found === null) {
      throw new NotFoundException(CUSTOMER_RESERVATION_NOT_FOUND_MESSAGE);
    }

    await lockTables(tx, [found.tableId]);
    await this.reservations.claim(tx, id, version, false);

    return tx.reservation.findUniqueOrThrow({
      where: { id },
      select: CUSTOMER_COLUMNS,
    });
  }

  /** One booking as its guest sees it. */
  private async read(
    tx: Tx,
    id: string,
    now: Date,
  ): Promise<CustomerReservationResponse> {
    const row = await tx.reservation.findUniqueOrThrow({
      where: { id },
      select: CUSTOMER_COLUMNS,
    });
    const table = (await this.tables(tx, [row.tableId])).get(row.tableId)!;

    return customerReservation(row, table, now);
  }

  /** The tables named, with their rooms, read in turn (*Data and migrations*). */
  private async tables(
    client: Pick<Tx, 'diningTable' | 'venue'>,
    ids: string[],
  ): Promise<Map<string, GuestTable>> {
    const tables = await client.diningTable.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: {
        id: true,
        code: true,
        name: true,
        capacity: true,
        active: true,
        venueId: true,
      },
    });
    const venues = await client.venue.findMany({
      where: { id: { in: [...new Set(tables.map((t) => t.venueId))] } },
      select: { id: true, slug: true, customerTitle: true, bigParty: true },
    });

    return new Map(
      tables.map((table) => {
        const venue = venues.find((v) => v.id === table.venueId)!;

        return [
          table.id,
          {
            code: table.code,
            name: table.name,
            capacity: table.capacity,
            active: table.active,
            venue: venue.slug,
            venueTitle: venue.customerTitle,
            bigParty: venue.bigParty,
          },
        ];
      }),
    );
  }

  /** The customer's name for the audit row, else the name on the booking. */
  private async customerName(
    tx: Tx,
    customerId: string,
    fallback: string,
  ): Promise<string> {
    const row = await tx.customer.findUnique({
      where: { id: customerId },
      select: { name: true },
    });

    return row?.name.trim() || fallback;
  }
}

/** A booking as its guest sees it, judged against `now` for `changeable`. */
function customerReservation(
  row: CustomerRow,
  table: GuestTable,
  now: Date,
): CustomerReservationResponse {
  return {
    id: row.id,
    number: row.number,
    venue: table.venue,
    venueTitle: table.venueTitle,
    tableCode: table.code,
    tableName: table.name,
    capacity: table.capacity,
    businessDate: formatIsoDate(row.businessDate),
    time: clockText(row.startMinutes),
    startMinutes: row.startMinutes,
    party: row.party,
    name: row.name,
    note: row.guestNote,
    status: row.status,
    source: row.source,
    startsAt: bookingStart(row.businessDate, row.startMinutes).toISOString(),
    changeableUntil: changeableUntil(
      row.businessDate,
      row.startMinutes,
    ).toISOString(),
    changeable:
      row.status === ReservationStatus.CONFIRMED &&
      !insideChangeWindow(row.businessDate, row.startMinutes, now),
    createdAt: row.createdAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    version: row.version,
  };
}
