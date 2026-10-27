import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  OrderStatus,
  ReservationSource,
  ReservationStatus,
  StaffRole,
  TableKind,
  TableSessionStatus,
} from '../generated/cnc-client';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import {
  addDays,
  formatIsoDate,
  parseIsoDate,
} from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { IDEMPOTENCY_KEY_REQUIRED } from '../src/idempotency/idempotency-key.decorator';
import { IDEMPOTENCY_KEY_REUSED } from '../src/idempotency/idempotency.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { drawNumber } from '../src/prisma/sequences';
import {
  ALREADY_ALLOCATED_MESSAGE,
  ALREADY_RESERVED_MESSAGE,
  ARRIVAL_TIME_MESSAGE,
  CANCEL_CONFIRMED_MESSAGE,
  CANCEL_TIME_MESSAGE,
  CAPACITY_MESSAGE,
  CHANGE_CONFIRMED_MESSAGE,
  CHECKIN_ALLOCATED_MESSAGE,
  CHECKIN_CONFIRMED_MESSAGE,
  CHECKIN_DATE_MESSAGE,
  CLOSED_DAY_MESSAGE,
  FUTURE_TIME_MESSAGE,
  GUEST_EMAIL_MESSAGE,
  GUEST_NAME_PHONE_MESSAGE,
  GUESTS_SEATED_MESSAGE,
  LOCK_REASON_MESSAGE,
  NO_ALLOCATION_MESSAGE,
  NOSHOW_CONFIRMED_MESSAGE,
  NOSHOW_TIME_MESSAGE,
  OPENING_HOURS_MESSAGE,
  RESERVATION_DATE_MESSAGE,
  RESERVATION_NOT_FOUND_MESSAGE,
  SEAT_GUESTS_MESSAGE,
  TABLE_LOCKED_MESSAGE,
  TABLE_NOT_FOUND_MESSAGE,
  TABLE_RESERVED_MESSAGE,
  TABLE_STATUS_MESSAGE,
  UNSETTLED_ORDERS_MESSAGE,
  VENUE_MESSAGE,
} from '../src/reception/reception-messages';
import { createTestApp } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { readBell } from './staff-bell';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

interface Booking {
  id: string;
  number: string;
  tableId: string;
  tableRef: string;
  customerId: string | null;
  name: string;
  phone: string;
  email: string;
  businessDate: string;
  time: string;
  startMinutes: number;
  party: number;
  status: ReservationStatus;
  source: ReservationSource;
  note: string;
  depositKobo: number;
  cancelledAt: string | null;
  version: number;
}

interface Session {
  id: string;
  tableId: string;
  tableRef: string;
  status: TableSessionStatus;
  guest: string;
  party: number;
  note: string;
  reservationId: string | null;
  reminderDue: boolean;
  endedAt: string | null;
  version: number;
}

interface FloorTable {
  id: string;
  ref: string;
  status: string;
  session: Session | null;
  reservations: {
    number: string;
    phone: string | null;
    email: string | null;
    version: number;
  }[];
  orders: { number: string; department: Department }[];
}

interface BellItem {
  id: string;
  title: string;
  detail: string;
  page: string;
  category: string;
}

/**
 * Reception (card C4-7) through HTTP and against Postgres: bookings
 * (create, check in, cancel, no show, change), table sessions (allocate,
 * release), the floor read and the Free Table Reminder. It ports the demo's
 * reservation and table tests by name, the C4 gate's steps 9 to 11, and
 * adds the booking race the plan's C4-10 names: two bookings for one table
 * and date, of which the database lets one through.
 *
 * It runs on a database of its own (`createIsolatedDatabase`): it changes
 * the opening hours and the reminder time, which every suite shares, and
 * reads the whole floor and the bell. Times the routes cannot reach (a
 * booking already past its time, guests seated three hours ago) are written
 * directly.
 */
describe('Reception (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  const token: Partial<Record<StaffRole, string>> = {};
  const staffId: Partial<Record<StaffRole, string>> = {};

  let diningId: string;
  let loungeId: string;
  /** The Lounge's TS1 (2 places), for the C4 gate's step 9. */
  let loungeTs1: string;
  let tableCount = 0;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    const tokens = app.get(CncTokenService, { strict: false });

    await prisma.settings.createMany({ data: [{}], skipDuplicates: true });

    // Only Date is faked, at the next 12:00 in Jos: a booking for today at
    // 23:45 or 23:59 is refused as past in the last minutes of a Lagos day
    // on the real clock. Tokens are minted after, at the suite's time.
    fakeDateOnly(nextNoonInJos());

    for (const role of Object.values(StaffRole)) {
      const made = await createStaffAccount(prisma, role, {
        emailPrefix: 'reception',
        name: `Reception suite ${role.toLowerCase()}`,
      });
      token[role] = await accessTokenFor(tokens, made.id);
      staffId[role] = made.id;
    }

    diningId = (
      await prisma.venue.create({
        data: {
          slug: 'dining',
          customerTitle: 'Dining',
          staffName: 'Diner',
          bigParty: 4,
          sort: 1,
        },
      })
    ).id;
    loungeId = (
      await prisma.venue.create({
        data: {
          slug: 'lounge',
          customerTitle: 'Lounge',
          staffName: 'Lounge',
          bigParty: 5,
          sort: 2,
        },
      })
    ).id;
    loungeTs1 = (
      await prisma.diningTable.create({
        data: {
          venueId: loungeId,
          code: 'TS1',
          name: 'Lounge table 1',
          kind: TableKind.TWO,
          capacity: 2,
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const auth = (role: StaffRole) => ({
    Authorization: `Bearer ${token[role]}`,
  });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;
  const sentencesOf = (response: request.Response) =>
    [messageOf(response)].flat();
  const dayFromToday = (days: number) =>
    formatIsoDate(addDays(watToday(new Date()), days));
  const today = () => dayFromToday(0);
  const tomorrow = () => dayFromToday(1);

  /** A run-unique Diner table: Booth n, 3 places unless told otherwise. */
  async function newTable(capacity = 3): Promise<{ id: string; ref: string }> {
    tableCount += 1;
    const code = `B${100 + tableCount}`;
    const table = await prisma.diningTable.create({
      data: {
        venueId: diningId,
        code,
        name: `Booth ${100 + tableCount}`,
        kind: TableKind.BOOTH,
        capacity,
      },
      select: { id: true },
    });

    return { id: table.id, ref: `D-${code}` };
  }

  const guest = (overrides: Record<string, unknown> = {}) => ({
    name: 'Test Guest',
    phone: '08000000000',
    email: 'guest@example.com',
    party: 2,
    businessDate: tomorrow(),
    time: '19:00',
    ...overrides,
  });

  function book(
    body: Record<string, unknown>,
    role: StaffRole = StaffRole.RECEPTION,
    key: string | null = randomUUID(),
  ) {
    const call = request(server())
      .post('/api/v1/staff/reservations')
      .set(auth(role));

    if (key !== null) call.set('Idempotency-Key', key);

    return call.send(body);
  }

  async function booked(body: Record<string, unknown>): Promise<Booking> {
    const response = await book(body).expect(201);

    return response.body as Booking;
  }

  /** A booking written directly: one the routes refuse to make now (in the past). */
  async function insertBooking(
    tableId: string,
    businessDate: string,
    startMinutes: number,
    party = 2,
  ): Promise<{ id: string; number: string; version: number }> {
    return prisma.reservation.create({
      data: {
        number: await drawNumber(prisma, 'reservation'),
        tableId,
        name: 'Direct Guest',
        phone: '08030000000',
        email: 'direct@example.com',
        businessDate: parseIsoDate(businessDate)!,
        startMinutes,
        party,
        source: ReservationSource.RECEPTION,
      },
      select: { id: true, number: true, version: true },
    });
  }

  const command = (
    id: string,
    action: 'check-in' | 'cancel' | 'no-show',
    version: number,
    role: StaffRole = StaffRole.RECEPTION,
  ) =>
    request(server())
      .post(`/api/v1/staff/reservations/${id}/${action}`)
      .set(auth(role))
      .send({ version });

  const allocate = (
    tableId: string,
    body: Record<string, unknown>,
    role: StaffRole = StaffRole.RECEPTION,
  ) =>
    request(server())
      .post(`/api/v1/staff/tables/${tableId}/allocate`)
      .set(auth(role))
      .send(body);

  const release = (
    tableId: string,
    session: { id: string; version: number },
    role: StaffRole = StaffRole.RECEPTION,
  ) =>
    request(server())
      .post(`/api/v1/staff/tables/${tableId}/release`)
      .set(auth(role))
      .send({ sessionId: session.id, version: session.version });

  async function floor(
    role: StaffRole = StaffRole.RECEPTION,
    query: Record<string, string> = {},
  ): Promise<FloorTable[]> {
    const response = await request(server())
      .get('/api/v1/staff/floor')
      .query(query)
      .set(auth(role))
      .expect(200);

    return (response.body as { tables: FloorTable[] }).tables;
  }

  async function bell(role: StaffRole): Promise<BellItem[]> {
    return (await readBell(server(), auth(role))).data;
  }

  async function history(ref: string) {
    const response = await request(server())
      .get('/api/v1/staff/audit')
      .query({ ref })
      .set(auth(StaffRole.OWNER))
      .expect(200);

    return (
      response.body as {
        data: { action: string; actionLabel: string; changes: string[] }[];
      }
    ).data;
  }

  describe('the C4 gate, steps 9 to 11', () => {
    it('9. Reception books Lounge table TS1 for tomorrow; a second booking for the table and date is refused', async () => {
      const first = await booked(guest({ tableId: loungeTs1 }));

      expect(first).toMatchObject({
        tableRef: 'L-TS1',
        businessDate: tomorrow(),
        time: '19:00',
        startMinutes: 1140,
        party: 2,
        status: ReservationStatus.CONFIRMED,
        source: ReservationSource.RECEPTION,
        depositKobo: 0,
        version: 0,
      });
      expect(first.number).toMatch(/^RSV-\d{6}$/);

      const second = await book(
        guest({ tableId: loungeTs1, name: 'Second Guest', time: '21:00' }),
      ).expect(409);

      expect(messageOf(second)).toBe(ALREADY_RESERVED_MESSAGE);
      expect(
        await prisma.reservation.count({
          where: {
            tableId: loungeTs1,
            businessDate: parseIsoDate(tomorrow())!,
          },
        }),
      ).toBe(1);
    });

    it('10. check-in, then release: the table is Occupied, then free, and the booking Completed', async () => {
      const table = await newTable();
      const arrival = await insertBooking(table.id, today(), 0);

      const checkedIn = await command(arrival.id, 'check-in', 0).expect(200);
      const { reservation, session } = checkedIn.body as {
        reservation: Booking;
        session: Session;
      };

      expect(reservation.status).toBe(ReservationStatus.CHECKED_IN);
      expect(session).toMatchObject({
        tableRef: table.ref,
        status: TableSessionStatus.OCCUPIED,
        guest: 'Direct Guest',
        party: 2,
        reservationId: arrival.id,
        reminderDue: false,
      });

      const seated = (await floor()).find((row) => row.id === table.id)!;

      expect(seated.status).toBe('OCCUPIED');
      expect(seated.session?.id).toBe(session.id);

      const released = await release(table.id, session).expect(200);

      expect(released.body).toMatchObject({
        completedReservations: [arrival.number],
        session: { id: session.id },
      });
      expect(
        (released.body as { session: Session }).session.endedAt,
      ).not.toBeNull();

      const freed = (await floor()).find((row) => row.id === table.id)!;

      expect(freed.status).toBe('AVAILABLE');
      expect(freed.session).toBeNull();
      expect(
        (
          await prisma.reservation.findUniqueOrThrow({
            where: { id: arrival.id },
          })
        ).status,
      ).toBe(ReservationStatus.COMPLETED);
    });

    it('11. the Free Table Reminder appears after the set time, for Reception and managers', async () => {
      const table = await newTable();
      const seated = await allocate(table.id, {
        status: TableSessionStatus.OCCUPIED,
        guest: 'Walk-in',
        party: 2,
      }).expect(201);
      const session = seated.body as Session;
      const itemFor = (items: BellItem[]) =>
        items.find((item) => item.id.startsWith(`free:${table.id}:`));

      expect(session.reminderDue).toBe(false);
      expect(itemFor(await bell(StaffRole.RECEPTION))).toBeUndefined();

      // Seated 179 minutes ago: not yet (the reminder is 180 by default).
      await prisma.tableSession.update({
        where: { id: session.id },
        data: { since: new Date(Date.now() - 179 * 60_000) },
      });
      expect(itemFor(await bell(StaffRole.RECEPTION))).toBeUndefined();

      // Seated 181 minutes ago: due.
      await prisma.tableSession.update({
        where: { id: session.id },
        data: { since: new Date(Date.now() - 181 * 60_000) },
      });

      const item = itemFor(await bell(StaffRole.RECEPTION));

      expect(item).toMatchObject({
        title: 'Free Table Reminder',
        detail: `Booth ${table.ref.slice(3)} · Walk-in seated 3 hours ago. Free it if they have left.`,
        page: 'reception',
        category: 'Reception',
      });
      expect(itemFor(await bell(StaffRole.MANAGER))).toBeDefined();
      expect(itemFor(await bell(StaffRole.OWNER))).toBeDefined();
      expect(itemFor(await bell(StaffRole.WAITER))).toBeUndefined();
      expect(itemFor(await bell(StaffRole.CASHIER))).toBeUndefined();

      const row = (await floor()).find((t) => t.id === table.id)!;

      expect(row.session?.reminderDue).toBe(true);

      // The reminder time is the Owner's setting, read live.
      await prisma.settings.update({
        where: { singleton: true },
        data: { freeTableReminderMinutes: 15 },
      });
      await prisma.tableSession.update({
        where: { id: session.id },
        data: { since: new Date(Date.now() - 20 * 60_000) },
      });

      try {
        expect(itemFor(await bell(StaffRole.RECEPTION))?.detail).toBe(
          `Booth ${table.ref.slice(3)} · Walk-in seated 20 minutes ago. Free it if they have left.`,
        );
      } finally {
        await prisma.settings.update({
          where: { singleton: true },
          data: { freeTableReminderMinutes: 180 },
        });
      }

      // A locked table is never "seated".
      const locked = await newTable();

      await allocate(locked.id, {
        status: TableSessionStatus.LOCKED,
        note: 'Broken chair',
      }).expect(201);
      await prisma.tableSession.updateMany({
        where: { tableId: locked.id },
        data: { since: new Date(Date.now() - 600 * 60_000) },
      });
      expect(
        (await bell(StaffRole.RECEPTION)).some((i) =>
          i.id.startsWith(`free:${locked.id}:`),
        ),
      ).toBe(false);
    });
  });

  describe('one active booking per table and date', () => {
    it('two bookings racing for one table and date: the database lets exactly one through', async () => {
      const table = await newTable();
      const attempts = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          book(guest({ tableId: table.id, name: `Racer ${i}` })),
        ),
      );
      const statuses = attempts.map((response) => response.status).sort();

      expect(statuses).toEqual([201, 409, 409, 409, 409]);

      for (const refused of attempts.filter((r) => r.status === 409)) {
        expect(messageOf(refused)).toBe(ALREADY_RESERVED_MESSAGE);
      }

      expect(
        await prisma.reservation.count({ where: { tableId: table.id } }),
      ).toBe(1);
    });

    it('a booking keeps its table for the whole date until staff free it', async () => {
      const table = await newTable();
      const other = await newTable();
      const date = dayFromToday(2);
      const first = await booked(
        guest({ tableId: table.id, businessDate: date, time: '10:00' }),
      );

      expect(
        messageOf(
          await book(
            guest({ tableId: table.id, businessDate: date, time: '18:00' }),
          ).expect(409),
        ),
      ).toBe(ALREADY_RESERVED_MESSAGE);

      await booked(guest({ tableId: other.id, businessDate: date }));
      await booked(guest({ tableId: table.id, businessDate: dayFromToday(3) }));
      await command(first.id, 'cancel', first.version).expect(200);
      await booked(
        guest({ tableId: table.id, businessDate: date, time: '18:00' }),
      );

      expect(
        await prisma.reservation.count({
          where: {
            tableId: table.id,
            businessDate: parseIsoDate(date)!,
            status: ReservationStatus.CONFIRMED,
          },
        }),
      ).toBe(1);
    });

    it('a retried booking replays the first under its Idempotency-Key', async () => {
      const table = await newTable();
      const key = randomUUID();
      const body = guest({ tableId: table.id });
      const first = await book(body, StaffRole.RECEPTION, key).expect(201);
      const again = await book(body, StaffRole.RECEPTION, key).expect(201);

      expect(again.body).toEqual(first.body);
      expect(
        await prisma.reservation.count({ where: { tableId: table.id } }),
      ).toBe(1);

      const reused = await book(
        { ...body, party: 3 },
        StaffRole.RECEPTION,
        key,
      ).expect(409);

      expect(messageOf(reused)).toBe(IDEMPOTENCY_KEY_REUSED);

      const missing = await book(body, StaffRole.RECEPTION, null).expect(400);

      expect(messageOf(missing)).toBe(IDEMPOTENCY_KEY_REQUIRED);
    });
  });

  describe('reservation.create', () => {
    it('reception must record a guest email for a reservation', async () => {
      const table = await newTable();

      for (const email of [undefined, 'not-an-email', '']) {
        const refused = await book(guest({ tableId: table.id, email })).expect(
          400,
        );

        expect(sentencesOf(refused)).toEqual([GUEST_EMAIL_MESSAGE]);
      }

      const made = await booked(
        guest({ tableId: table.id, email: ' Ada@Example.com ' }),
      );

      expect(made.email).toBe('ada@example.com');
    });

    it('answers each input problem once, in the demo’s words', async () => {
      const table = await newTable();
      const once = async (body: Record<string, unknown>, sentence: string) =>
        expect(sentencesOf(await book(body).expect(400))).toEqual([sentence]);

      await once(
        guest({ tableId: table.id, name: '' }),
        GUEST_NAME_PHONE_MESSAGE,
      );
      await once(
        guest({ tableId: table.id, name: ' ', phone: '' }),
        GUEST_NAME_PHONE_MESSAGE,
      );
      await once(
        guest({ tableId: table.id, phone: '' }),
        GUEST_NAME_PHONE_MESSAGE,
      );
      await once(guest({ tableId: table.id, party: 0 }), CAPACITY_MESSAGE);
      await once(guest({ tableId: '', party: 0 }), CAPACITY_MESSAGE);
      await once(
        guest({ tableId: table.id, businessDate: '2026-02-30' }),
        RESERVATION_DATE_MESSAGE,
      );
      await once(
        guest({ tableId: table.id, time: '7pm' }),
        ARRIVAL_TIME_MESSAGE,
      );
    });

    it('refuses a party above the table’s places, an unknown table and one out of use', async () => {
      const table = await newTable(3);

      expect(
        messageOf(
          await book(guest({ tableId: table.id, party: 4 })).expect(400),
        ),
      ).toBe(CAPACITY_MESSAGE);
      expect(
        messageOf(await book(guest({ tableId: 'no-such-table' })).expect(400)),
      ).toBe(CAPACITY_MESSAGE);

      const retired = await newTable();

      await prisma.diningTable.update({
        where: { id: retired.id },
        data: { active: false },
      });
      expect(
        messageOf(await book(guest({ tableId: retired.id })).expect(400)),
      ).toBe(CAPACITY_MESSAGE);

      // Reception is the team: a party of the room's large-group size books
      // when the table holds it.
      const big = await newTable(6);

      await booked(guest({ tableId: big.id, party: 6 }));
    });

    it('refuses a past arrival, and holds Reception to the opening hours (Q30)', async () => {
      const table = await newTable();

      expect(
        messageOf(
          await book(
            guest({ tableId: table.id, businessDate: dayFromToday(-1) }),
          ).expect(400),
        ),
      ).toBe(FUTURE_TIME_MESSAGE);
      expect(
        messageOf(
          await book(guest({ tableId: table.id, time: '07:59' })).expect(400),
        ),
      ).toBe(OPENING_HOURS_MESSAGE);

      // Off the website's 30-minute grid and after its 23:00 last arrival:
      // both are Reception's to book (Q30).
      const late = await booked(guest({ tableId: table.id, time: '23:45' }));

      expect(late.time).toBe('23:45');
    });

    it('refuses a day the opening hours mark closed', async () => {
      const table = await newTable();
      const date = dayFromToday(4);
      const dayOfWeek = parseIsoDate(date)!.getUTCDay();
      const before = await prisma.openingHoursDay.findUniqueOrThrow({
        where: { dayOfWeek },
      });

      await prisma.openingHoursDay.update({
        where: { dayOfWeek },
        data: { isClosed: true, opensAtMinutes: null, closesAtMinutes: null },
      });

      try {
        expect(
          messageOf(
            await book(guest({ tableId: table.id, businessDate: date })).expect(
              400,
            ),
          ),
        ).toBe(CLOSED_DAY_MESSAGE);
      } finally {
        await prisma.openingHoursDay.update({
          where: { dayOfWeek },
          data: {
            isClosed: before.isClosed,
            opensAtMinutes: before.opensAtMinutes,
            closesAtMinutes: before.closesAtMinutes,
          },
        });
      }
    });

    it('refuses a Locked table, and a table with guests seated for today', async () => {
      const locked = await newTable();

      await allocate(locked.id, {
        status: TableSessionStatus.LOCKED,
        note: 'Private event',
      }).expect(201);
      expect(
        messageOf(await book(guest({ tableId: locked.id })).expect(409)),
      ).toBe(TABLE_LOCKED_MESSAGE);

      const seated = await newTable();

      await allocate(seated.id, {
        status: TableSessionStatus.OCCUPIED,
        guest: 'Walk-in',
        party: 2,
      }).expect(201);
      expect(
        messageOf(
          await book(
            guest({ tableId: seated.id, businessDate: today(), time: '23:59' }),
          ).expect(409),
        ),
      ).toBe(GUESTS_SEATED_MESSAGE);

      // Seated now does not hold tomorrow.
      await booked(guest({ tableId: seated.id }));
    });

    it('links a booking to a customer only on a verified email or phone (Q35), and never creates one', async () => {
      const verified = await prisma.customer.create({
        data: {
          memberNo: await drawNumber(prisma, 'customer'),
          name: 'Verified Customer',
          email: 'verified@example.com',
          emailVerifiedAt: new Date(),
          phone: '08031112222',
          phoneVerifiedAt: new Date(),
        },
      });
      await prisma.customer.create({
        data: {
          memberNo: await drawNumber(prisma, 'customer'),
          name: 'Unverified Customer',
          email: 'unverified@example.com',
        },
      });
      const customers = await prisma.customer.count();

      const byEmail = await booked(
        guest({
          tableId: (await newTable()).id,
          email: 'Verified@Example.com',
        }),
      );
      const byPhone = await booked(
        guest({ tableId: (await newTable()).id, phone: '+234 803 111 2222' }),
      );
      const unverified = await booked(
        guest({
          tableId: (await newTable()).id,
          email: 'unverified@example.com',
        }),
      );
      const stranger = await booked(
        guest({ tableId: (await newTable()).id, email: 'new@example.com' }),
      );

      expect(byEmail.customerId).toBe(verified.id);
      expect(byPhone.customerId).toBe(verified.id);
      expect(byPhone.phone).toBe('08031112222');
      expect(unverified.customerId).toBeNull();
      expect(stranger.customerId).toBeNull();
      expect(await prisma.customer.count()).toBe(customers);
    });

    it('is Reception’s and the managers’: other roles are refused', async () => {
      const table = await newTable();

      for (const role of [
        StaffRole.CASHIER,
        StaffRole.WAITER,
        StaffRole.BARTENDER,
        StaffRole.KITCHEN,
        StaffRole.STOREKEEPER,
      ]) {
        expect(
          messageOf(await book(guest({ tableId: table.id }), role).expect(403)),
        ).toBe(ROLE_REFUSED_MESSAGE);
      }

      await book(guest({ tableId: table.id }), StaffRole.MANAGER).expect(201);
    });

    it('writes the history in plain words, readable by managers only', async () => {
      const made = await booked(
        guest({ tableId: (await newTable()).id, note: 'Window please' }),
      );
      const [row] = await history(made.number);

      expect(row.action).toBe('reservation.create');
      expect(row.actionLabel).toBe('Reservation Made');
      expect(row.changes).toEqual(
        expect.arrayContaining([
          'Party: 2.',
          'Time: 19:00.',
          'Note: Window please.',
          `Business Date: ${tomorrow()}.`,
          'Source: Reception.',
        ]),
      );

      // Plan §4.8: a booking is not among the records a non-manager may
      // read the history of.
      await request(server())
        .get('/api/v1/staff/audit')
        .query({ ref: made.number })
        .set(auth(StaffRole.RECEPTION))
        .expect(403);
    });
  });

  describe('reservation.checkin', () => {
    it('check in stays open for the whole booking date', async () => {
      const table = await newTable();
      // Booked for 00:00 today, so its time has long passed.
      const arrival = await insertBooking(table.id, today(), 0);

      await command(arrival.id, 'check-in', arrival.version).expect(200);
    });

    it('only on the booking date, only a Confirmed booking, only at a free table', async () => {
      const table = await newTable();
      const later = await booked(guest({ tableId: table.id }));

      expect(
        messageOf(
          await command(later.id, 'check-in', later.version).expect(409),
        ),
      ).toBe(CHECKIN_DATE_MESSAGE);

      const busy = await newTable();
      const arrival = await insertBooking(busy.id, today(), 0);

      await allocate(busy.id, {
        status: TableSessionStatus.LOCKED,
        note: 'Being cleaned',
      }).expect(409);
      // The booking for today holds the table against a walk-in or a lock;
      // a seating written directly stands in for one made before it.
      await prisma.tableSession.create({
        data: {
          tableId: busy.id,
          status: TableSessionStatus.LOCKED,
          note: 'Being cleaned',
          openedById: staffId[StaffRole.RECEPTION]!,
        },
      });
      expect(
        messageOf(await command(arrival.id, 'check-in', 0).expect(409)),
      ).toBe(CHECKIN_ALLOCATED_MESSAGE);

      const cancelled = await insertBooking((await newTable()).id, today(), 0);

      await prisma.reservation.update({
        where: { id: cancelled.id },
        data: { status: ReservationStatus.CANCELLED, cancelledAt: new Date() },
      });
      expect(
        messageOf(await command(cancelled.id, 'check-in', 0).expect(409)),
      ).toBe(CHECKIN_CONFIRMED_MESSAGE);
    });

    it('answers a stale version and an unknown booking', async () => {
      const arrival = await insertBooking((await newTable()).id, today(), 0);

      await command(arrival.id, 'check-in', 0).expect(200);
      expect(
        messageOf(await command(arrival.id, 'check-in', 0).expect(409)),
      ).toBe(STALE_VERSION_MESSAGE);
      expect(
        messageOf(await command(arrival.id, 'check-in', 1).expect(409)),
      ).toBe(CHECKIN_CONFIRMED_MESSAGE);
      expect(
        messageOf(await command('no-such-booking', 'check-in', 0).expect(404)),
      ).toBe(RESERVATION_NOT_FOUND_MESSAGE);
    });
  });

  describe('reservation.cancel and reservation.noshow', () => {
    it('cancelling a reservation before arrival takes no deposit and records no refund', async () => {
      const made = await booked(guest({ tableId: (await newTable()).id }));
      const cancelled = await command(made.id, 'cancel', made.version).expect(
        200,
      );
      const body = cancelled.body as Booking;

      expect(body.status).toBe(ReservationStatus.CANCELLED);
      expect(body.cancelledAt).not.toBeNull();
      expect(body.depositKobo).toBe(0);
      expect(
        messageOf(await command(made.id, 'cancel', body.version).expect(409)),
      ).toBe(CANCEL_CONFIRMED_MESSAGE);

      const [row] = await history(made.number);

      expect(row.changes).toEqual([
        'Status changed from Confirmed to Cancelled.',
      ]);
    });

    it('cancel only before the booking time', async () => {
      const passed = await insertBooking((await newTable()).id, today(), 0);

      expect(messageOf(await command(passed.id, 'cancel', 0).expect(409))).toBe(
        CANCEL_TIME_MESSAGE,
      );
    });

    it('a hold never marks a no show by itself; staff mark it after the booking time', async () => {
      const passed = await insertBooking(
        (await newTable()).id,
        dayFromToday(-1),
        720,
      );

      expect(
        (
          await prisma.reservation.findUniqueOrThrow({
            where: { id: passed.id },
          })
        ).status,
      ).toBe(ReservationStatus.CONFIRMED);

      const later = await booked(guest({ tableId: (await newTable()).id }));

      expect(
        messageOf(
          await command(later.id, 'no-show', later.version).expect(409),
        ),
      ).toBe(NOSHOW_TIME_MESSAGE);

      const marked = await command(passed.id, 'no-show', 0).expect(200);

      expect((marked.body as Booking).status).toBe(ReservationStatus.NO_SHOW);
      expect(
        messageOf(await command(passed.id, 'no-show', 1).expect(409)),
      ).toBe(NOSHOW_CONFIRMED_MESSAGE);
    });

    it('a stale version is refused', async () => {
      const made = await booked(guest({ tableId: (await newTable()).id }));

      await command(made.id, 'cancel', made.version).expect(200);
      expect(
        messageOf(await command(made.id, 'cancel', made.version).expect(409)),
      ).toBe(STALE_VERSION_MESSAGE);
    });

    it('a cancelled or no-show booking frees the table for the date', async () => {
      const table = await newTable();
      const made = await booked(guest({ tableId: table.id }));

      await command(made.id, 'cancel', made.version).expect(200);
      await booked(guest({ tableId: table.id, time: '20:00' }));
    });
  });

  describe('reservation.change', () => {
    const change = (id: string, body: Record<string, unknown>) =>
      request(server())
        .patch(`/api/v1/staff/reservations/${id}`)
        .set(auth(StaffRole.RECEPTION))
        .send(body);

    it('changes only the fields sent, and checks again what they touch', async () => {
      const table = await newTable(3);
      const made = await booked(guest({ tableId: table.id }));

      expect(
        messageOf(
          await change(made.id, { version: made.version, party: 4 }).expect(
            400,
          ),
        ),
      ).toBe(CAPACITY_MESSAGE);
      expect(
        messageOf(
          await change(made.id, {
            version: made.version,
            time: '06:00',
          }).expect(400),
        ),
      ).toBe(OPENING_HOURS_MESSAGE);

      const taken = await newTable();

      await booked(guest({ tableId: taken.id }));
      expect(
        messageOf(
          await change(made.id, {
            version: made.version,
            tableId: taken.id,
          }).expect(409),
        ),
      ).toBe(ALREADY_RESERVED_MESSAGE);

      const target = await newTable(4);
      const changed = await change(made.id, {
        version: made.version,
        tableId: target.id,
        party: 4,
        time: '20:30',
        name: 'Changed Guest',
      }).expect(200);
      const body = changed.body as Booking;

      expect(body).toMatchObject({
        tableId: target.id,
        party: 4,
        time: '20:30',
        name: 'Changed Guest',
        phone: '08000000000',
        email: 'guest@example.com',
        businessDate: tomorrow(),
        version: made.version + 1,
      });

      // The old table is free for the date again.
      await booked(guest({ tableId: table.id }));

      const [row] = await history(made.number);

      expect(row.actionLabel).toBe('Reservation Changed');
      expect(row.changes).toEqual(
        expect.arrayContaining([
          'Name changed from Test Guest to Changed Guest.',
          'Time changed from 19:00 to 20:30.',
          'Party changed from 2 to 4.',
          `Table changed from ${table.ref} to ${target.ref}.`,
        ]),
      );
      expect(row.changes).toHaveLength(4);
    });

    it('two changes moving bookings onto one table and date: one wins', async () => {
      const target = await newTable();
      const a = await booked(guest({ tableId: (await newTable()).id }));
      const b = await booked(guest({ tableId: (await newTable()).id }));
      const results = await Promise.all(
        [a, b].map((made) =>
          change(made.id, { version: made.version, tableId: target.id }),
        ),
      );

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(messageOf(results.find((r) => r.status === 409)!)).toBe(
        ALREADY_RESERVED_MESSAGE,
      );
    });

    it('only a Confirmed booking, at its current version', async () => {
      const made = await booked(guest({ tableId: (await newTable()).id }));
      const cancelled = await command(made.id, 'cancel', made.version).expect(
        200,
      );

      expect(
        messageOf(
          await change(made.id, { version: made.version, party: 1 }).expect(
            409,
          ),
        ),
      ).toBe(STALE_VERSION_MESSAGE);
      expect(
        messageOf(
          await change(made.id, {
            version: (cancelled.body as Booking).version,
            party: 1,
          }).expect(409),
        ),
      ).toBe(CHANGE_CONFIRMED_MESSAGE);
    });
  });

  describe('table.allocate and table.release', () => {
    it('seats walk-ins and locks a table, in the demo’s order of refusals', async () => {
      const table = await newTable(3);

      expect(
        sentencesOf(
          await allocate(table.id, { status: 'AVAILABLE' }).expect(400),
        ),
      ).toEqual([TABLE_STATUS_MESSAGE]);
      expect(
        messageOf(
          await allocate(table.id, {
            status: TableSessionStatus.OCCUPIED,
            guest: 'Walk-in',
            party: 4,
          }).expect(400),
        ),
      ).toBe(SEAT_GUESTS_MESSAGE);
      expect(
        messageOf(
          await allocate(table.id, {
            status: TableSessionStatus.OCCUPIED,
            party: 2,
          }).expect(400),
        ),
      ).toBe(SEAT_GUESTS_MESSAGE);
      expect(
        messageOf(
          await allocate(table.id, {
            status: TableSessionStatus.LOCKED,
          }).expect(400),
        ),
      ).toBe(LOCK_REASON_MESSAGE);
      expect(
        messageOf(
          await allocate('no-such-table', {
            status: TableSessionStatus.LOCKED,
            note: 'x',
          }).expect(404),
        ),
      ).toBe(TABLE_NOT_FOUND_MESSAGE);

      const locked = await allocate(table.id, {
        status: TableSessionStatus.LOCKED,
        note: 'Broken leg',
      }).expect(201);

      expect(locked.body).toMatchObject({
        status: TableSessionStatus.LOCKED,
        note: 'Broken leg',
        guest: '',
        party: 0,
      });
      expect(
        messageOf(
          await allocate(table.id, {
            status: TableSessionStatus.OCCUPIED,
            guest: 'Walk-in',
            party: 2,
          }).expect(409),
        ),
      ).toBe(ALREADY_ALLOCATED_MESSAGE);
    });

    it('a table booked for today is checked in, not seated over', async () => {
      const table = await newTable();

      await insertBooking(table.id, today(), 1380);
      expect(
        messageOf(
          await allocate(table.id, {
            status: TableSessionStatus.OCCUPIED,
            guest: 'Walk-in',
            party: 2,
          }).expect(409),
        ),
      ).toBe(TABLE_RESERVED_MESSAGE);
    });

    it('two allocations of one table at once: one seating', async () => {
      const table = await newTable();
      const results = await Promise.all(
        ['First', 'Second'].map((name) =>
          allocate(table.id, {
            status: TableSessionStatus.OCCUPIED,
            guest: name,
            party: 2,
          }),
        ),
      );

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await prisma.tableSession.count({
          where: { tableId: table.id, endedAt: null },
        }),
      ).toBe(1);
    });

    it('paid seating stays occupied until reception manually releases it; unsettled bills of any date block it', async () => {
      const table = await newTable();
      const seated = await allocate(table.id, {
        status: TableSessionStatus.OCCUPIED,
        guest: 'Walk-in',
        party: 2,
      }).expect(201);
      const session = seated.body as Session;

      // A waiter opens a bill on the table through the till.
      const opened = await request(server())
        .post('/api/v1/staff/orders')
        .set(auth(StaffRole.WAITER))
        .set('Idempotency-Key', randomUUID())
        .send({ department: Department.RESTAURANT, tableId: table.id })
        .expect(201);
      const bill = opened.body as {
        id: string;
        number: string;
        version: number;
      };

      // And a Bar bill from yesterday is still awaiting payment.
      const carried = await prisma.order.create({
        data: {
          number: await drawNumber(prisma, 'orderBar'),
          department: Department.BAR,
          tableId: table.id,
          label: 'Carried',
          businessDate: parseIsoDate(dayFromToday(-1))!,
          status: OrderStatus.PAYMENT,
          vatBps: 0,
          serviceBps: 0,
          openedById: staffId[StaffRole.BARTENDER]!,
        },
      });

      const row = (await floor()).find((t) => t.id === table.id)!;

      expect(row.orders.map((o) => o.number)).toEqual([
        bill.number,
        carried.number,
      ]);
      expect(messageOf(await release(table.id, session).expect(409))).toBe(
        UNSETTLED_ORDERS_MESSAGE,
      );

      // The empty bill is cancelled by a manager; the Bar bill is settled.
      await request(server())
        .post(`/api/v1/staff/orders/${bill.id}/cancel`)
        .set(auth(StaffRole.MANAGER))
        .send({ version: bill.version, reason: 'Opened by mistake' })
        .expect(200);
      expect(messageOf(await release(table.id, session).expect(409))).toBe(
        UNSETTLED_ORDERS_MESSAGE,
      );
      await prisma.order.update({
        where: { id: carried.id },
        data: { status: OrderStatus.SETTLED, settledAt: new Date() },
      });

      // Still seated until Reception frees it.
      expect((await floor()).find((t) => t.id === table.id)!.status).toBe(
        'OCCUPIED',
      );

      await release(table.id, session).expect(200);
      expect(messageOf(await release(table.id, session).expect(409))).toBe(
        NO_ALLOCATION_MESSAGE,
      );

      const [entry] = await history(table.ref);

      expect(entry.action).toBe('table.release');
      expect(entry.changes).toEqual(
        expect.arrayContaining(['Status changed from Occupied to Available.']),
      );
    });

    it('a release names its seating: a stale screen cannot free the guests seated after', async () => {
      const table = await newTable();
      const first = (
        await allocate(table.id, {
          status: TableSessionStatus.OCCUPIED,
          guest: 'First party',
          party: 2,
        }).expect(201)
      ).body as Session;

      await release(table.id, first).expect(200);

      const second = (
        await allocate(table.id, {
          status: TableSessionStatus.OCCUPIED,
          guest: 'Second party',
          party: 2,
        }).expect(201)
      ).body as Session;

      // The first seating's id and version, pressed again on a stale screen.
      expect(messageOf(await release(table.id, first).expect(409))).toBe(
        NO_ALLOCATION_MESSAGE,
      );
      expect(
        messageOf(
          await release(table.id, {
            ...second,
            version: second.version + 1,
          }).expect(409),
        ),
      ).toBe(STALE_VERSION_MESSAGE);
      expect(
        await prisma.tableSession.count({
          where: { tableId: table.id, endedAt: null },
        }),
      ).toBe(1);
      expect(
        messageOf(await release('no-such-table', second).expect(404)),
      ).toBe(TABLE_NOT_FOUND_MESSAGE);
    });

    it('are Reception’s and the managers’', async () => {
      const table = await newTable();

      for (const role of [
        StaffRole.WAITER,
        StaffRole.CASHIER,
        StaffRole.KITCHEN,
      ]) {
        expect(
          messageOf(
            await allocate(
              table.id,
              { status: TableSessionStatus.LOCKED, note: 'x' },
              role,
            ).expect(403),
          ),
        ).toBe(ROLE_REFUSED_MESSAGE);
      }

      const made = (
        await allocate(
          table.id,
          { status: TableSessionStatus.LOCKED, note: 'Manager lock' },
          StaffRole.MANAGER,
        ).expect(201)
      ).body as Session;

      await release(table.id, made, StaffRole.WAITER).expect(403);
      await release(table.id, made, StaffRole.OWNER).expect(200);
    });
  });

  describe('the floor', () => {
    it('shows each table’s status for the date, its seating, bookings and bills', async () => {
      const reserved = await newTable();
      const made = await booked(guest({ tableId: reserved.id }));
      const tables = await floor(StaffRole.RECEPTION, {
        venue: 'dining',
        date: tomorrow(),
      });
      const row = tables.find((t) => t.id === reserved.id)!;

      expect(row.status).toBe('RESERVED');
      expect(row.reservations).toEqual([
        expect.objectContaining({
          number: made.number,
          phone: '08000000000',
          email: 'guest@example.com',
          version: made.version,
        }),
      ]);
      expect(tables.every((t) => t.ref.startsWith('D-'))).toBe(true);

      const lounge = await floor(StaffRole.RECEPTION, { venue: 'lounge' });

      expect(lounge.map((t) => t.ref)).toEqual(['L-TS1']);
      expect(
        (await floor(StaffRole.RECEPTION, { date: tomorrow() })).find(
          (t) => t.id === loungeTs1,
        )!.status,
      ).toBe('RESERVED');
    });

    it('a seating occupies today only; a lock holds every date', async () => {
      const seated = await newTable();
      const locked = await newTable();

      await allocate(seated.id, {
        status: TableSessionStatus.OCCUPIED,
        guest: 'Walk-in',
        party: 1,
      }).expect(201);
      await allocate(locked.id, {
        status: TableSessionStatus.LOCKED,
        note: 'Repairs',
      }).expect(201);

      const now = await floor();
      const later = await floor(StaffRole.RECEPTION, { date: dayFromToday(5) });

      expect(now.find((t) => t.id === seated.id)!.status).toBe('OCCUPIED');
      expect(later.find((t) => t.id === seated.id)!.status).toBe('AVAILABLE');
      expect(now.find((t) => t.id === locked.id)!.status).toBe('LOCKED');
      expect(later.find((t) => t.id === locked.id)!.status).toBe('LOCKED');
    });

    it('gives the till today only, without a phone or an email; a Bartender’s bills are Bar only', async () => {
      const table = await newTable();

      await insertBooking(table.id, today(), 1380);
      await prisma.order.create({
        data: {
          number: await drawNumber(prisma, 'orderRestaurant'),
          department: Department.RESTAURANT,
          tableId: table.id,
          label: 'Food',
          businessDate: watToday(new Date()),
          vatBps: 0,
          serviceBps: 0,
        },
      });
      const barBill = await prisma.order.create({
        data: {
          number: await drawNumber(prisma, 'orderBar'),
          department: Department.BAR,
          tableId: table.id,
          label: 'Drinks',
          businessDate: watToday(new Date()),
          vatBps: 0,
          serviceBps: 0,
        },
      });

      const waiter = (await floor(StaffRole.WAITER)).find(
        (t) => t.id === table.id,
      )!;

      expect(waiter.reservations[0]).toMatchObject({
        phone: null,
        email: null,
      });
      expect(waiter.orders).toHaveLength(2);

      const bartender = (await floor(StaffRole.BARTENDER)).find(
        (t) => t.id === table.id,
      )!;

      expect(bartender.orders.map((o) => o.number)).toEqual([barBill.number]);

      expect(
        messageOf(
          await request(server())
            .get('/api/v1/staff/floor')
            .query({ date: tomorrow() })
            .set(auth(StaffRole.WAITER))
            .expect(403),
        ),
      ).toBe(ROLE_REFUSED_MESSAGE);
      await request(server())
        .get('/api/v1/staff/floor')
        .query({ date: today() })
        .set(auth(StaffRole.CASHIER))
        .expect(200);
    });

    it('refuses an unknown room, and the roles with no floor', async () => {
      expect(
        messageOf(
          await request(server())
            .get('/api/v1/staff/floor')
            .query({ venue: 'garden' })
            .set(auth(StaffRole.RECEPTION))
            .expect(400),
        ),
      ).toBe(VENUE_MESSAGE);

      for (const role of [StaffRole.KITCHEN, StaffRole.STOREKEEPER]) {
        await request(server())
          .get('/api/v1/staff/floor')
          .set(auth(role))
          .expect(403);
      }
    });
  });

  describe('the booking list', () => {
    it('lists a date’s bookings by arrival, every date’s for History, and searches', async () => {
      const date = dayFromToday(6);
      const late = await booked(
        guest({
          tableId: (await newTable()).id,
          businessDate: date,
          time: '21:00',
          name: 'Zara Late',
          phone: '0803 444 5555',
        }),
      );
      const early = await booked(
        guest({
          tableId: (await newTable()).id,
          businessDate: date,
          time: '12:00',
          name: 'Amaka Early',
        }),
      );
      const list = async (query: Record<string, string>) =>
        (
          await request(server())
            .get('/api/v1/staff/reservations')
            .query(query)
            .set(auth(StaffRole.RECEPTION))
            .expect(200)
        ).body as { data: Booking[]; total: number };

      expect((await list({ date })).data.map((b) => b.number)).toEqual([
        early.number,
        late.number,
      ]);
      expect((await list({ date, q: 'zara' })).data).toHaveLength(1);
      expect((await list({ date, q: '0803 444' })).data[0].number).toBe(
        late.number,
      );
      expect(
        (await list({ all: 'true', q: '+2348034445555' })).data.map(
          (b) => b.number,
        ),
      ).toEqual([late.number]);
      expect((await list({ all: 'true', q: early.number })).total).toBe(1);

      const one = await request(server())
        .get(`/api/v1/staff/reservations/${early.id}`)
        .set(auth(StaffRole.RECEPTION))
        .expect(200);

      expect((one.body as Booking).name).toBe('Amaka Early');
      await request(server())
        .get('/api/v1/staff/reservations')
        .set(auth(StaffRole.WAITER))
        .expect(403);
    });
  });
});
