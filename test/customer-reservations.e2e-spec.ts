import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  OutboundMessageStatus,
  ReservationSource,
  ReservationStatus,
  StaffRole,
  SubjectType,
  TableSessionStatus,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { TOO_MANY_ATTEMPTS_MESSAGE } from '../src/auth/auth-throttle';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { CustomerService } from '../src/customers/customer.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { drawNumber } from '../src/prisma/sequences';
import { BOOKING_ADDRESS_LIMIT } from '../src/reception/booking-throttle';
import {
  ARRIVAL_SLOT_MESSAGE,
  CANCEL_CONFIRMED_MESSAGE,
  CAPACITY_MESSAGE,
  CHANGE_CONFIRMED_MESSAGE,
  CUSTOMER_ARRIVAL_MESSAGE,
  CUSTOMER_RESERVATION_NOT_FOUND_MESSAGE,
  LATE_CHANGE_MESSAGE,
  TAKEN_ONLINE_MESSAGE,
  WEB_GUEST_EMAIL_MESSAGE,
  WEB_GUEST_NAME_MESSAGE,
  WEB_GUEST_PHONE_MESSAGE,
  bigPartyMessage,
  customerCapacityMessage,
  customerTakenMessage,
} from '../src/reception/reception-messages';
import { createTestApp, sentMail } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';
import { clientAddress } from './staff-sessions';

interface Booking {
  id: string;
  number: string;
  venue: string;
  venueTitle: string;
  tableCode: string;
  tableName: string;
  capacity: number;
  businessDate: string;
  time: string;
  startMinutes: number;
  party: number;
  name: string;
  note: string;
  status: ReservationStatus;
  source: ReservationSource;
  startsAt: string;
  changeableUntil: string;
  changeable: boolean;
  createdAt: string;
  cancelledAt: string | null;
  version: number;
}

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const BOOKING_KEYS = [
  'businessDate',
  'cancelledAt',
  'capacity',
  'changeable',
  'changeableUntil',
  'createdAt',
  'id',
  'name',
  'note',
  'number',
  'party',
  'source',
  'startMinutes',
  'startsAt',
  'status',
  'tableCode',
  'tableName',
  'time',
  'venue',
  'venueTitle',
  'version',
];

const newEmail = () => `booking-${randomUUID()}@cnc.test`;

/**
 * Bookings from the website and the app (cards C6-5 and C6-6) through
 * HTTP and against Postgres: `POST /reservations` with and without a
 * customer token, the Q35/A15 customer link, and the customer's own
 * `/me/reservations` with the 24-hour rule (Q6), the races and the
 * boundary.
 *
 * On a database of its own (`createIsolatedDatabase`) seeded with the real
 * rooms, tables and opening hours, with only `Date` faked from the next
 * 12:00 in Jos, so the arrival grid and the 24-hour window are known
 * exactly. The clock only moves forward; the boundary tests run last.
 * Each test books its own date, so tables are reused without clashing.
 */
describe('customer reservations (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  let customers: CustomerService;
  let noon: number;
  let receptionAuth: { Authorization: string };
  let receptionId: string;
  let nextDay = 2;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });
    customers = app.get(CustomerService, { strict: false });

    await seedData(prisma);

    noon = nextNoonInJos();
    fakeDateOnly(noon);

    const reception = await createStaffAccount(prisma, StaffRole.RECEPTION, {
      emailPrefix: 'customer-reservations',
    });
    receptionId = reception.id;
    receptionAuth = {
      Authorization: `Bearer ${await accessTokenFor(tokens, reception.id)}`,
    };
  }, 120_000);

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;
  const sentence = (response: request.Response) =>
    [messageOf(response)].flat()[0];
  /** A date of the test's own, days ahead, so no two tests meet. */
  const freshDate = () =>
    formatIsoDate(addDays(watToday(new Date()), nextDay++));
  const dayFromToday = (days: number) =>
    formatIsoDate(addDays(watToday(new Date()), days));

  const guest = (overrides: Record<string, unknown> = {}) => ({
    venue: 'lounge',
    table: 'TDS1',
    businessDate: freshDate(),
    time: '19:00',
    party: 2,
    name: 'Ada Okafor',
    phone: '0803 123 4567',
    email: newEmail(),
    ...overrides,
  });

  const book = (
    body: Record<string, unknown>,
    options: {
      auth?: Record<string, string>;
      key?: string;
      address?: string;
    } = {},
  ) =>
    request(server())
      .post('/api/v1/reservations')
      .set('X-Forwarded-For', options.address ?? clientAddress())
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set(options.auth ?? {})
      .send(body);

  /** A verified customer with a session, made directly. */
  async function customer(email = newEmail()) {
    const { id } = await prisma.$transaction((tx) =>
      customers.findOrCreateVerified(tx, email),
    );
    const pair = await tokens.issueTokenPair(id, SubjectType.CUSTOMER);

    return {
      id,
      email,
      auth: { Authorization: `Bearer ${pair.accessToken}` },
    };
  }

  type Customer = Awaited<ReturnType<typeof customer>>;

  const mine = async (who: Customer) =>
    (
      (
        await request(server())
          .get('/api/v1/me/reservations')
          .set(who.auth)
          .expect(200)
      ).body as { data: Booking[] }
    ).data;

  const change = (who: Customer, id: string, body: Record<string, unknown>) =>
    request(server())
      .patch(`/api/v1/me/reservations/${id}`)
      .set(who.auth)
      .send(body);

  const cancel = (who: Customer, id: string, version: number) =>
    request(server())
      .post(`/api/v1/me/reservations/${id}/cancel`)
      .set(who.auth)
      .send({ version });

  const availability = async (venue: string, date: string) =>
    (
      (
        await request(server())
          .get(`/api/v1/venues/${venue}/availability?date=${date}`)
          .expect(200)
      ).body as { tables: { code: string; status: string }[] }
    ).tables;

  const tableStatus = async (venue: string, code: string, date: string) =>
    (await availability(venue, date)).find((table) => table.code === code)
      ?.status;

  const tableId = async (venue: string, code: string) =>
    (
      await prisma.diningTable.findFirstOrThrow({
        where: { code, venue: { slug: venue } },
        select: { id: true },
      })
    ).id;

  describe('POST /reservations from the website', () => {
    it('books as a guest: WEB, unlinked, emailed, on the floor plan and in Reception’s list', async () => {
      const body = guest({ note: 'A birthday' });
      const response = await book(body).expect(201);
      const made = response.body as Booking;

      expect(Object.keys(made).sort()).toEqual(BOOKING_KEYS);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(made).toMatchObject({
        venue: 'lounge',
        venueTitle: 'Lounge',
        tableCode: 'TDS1',
        businessDate: body.businessDate,
        time: '19:00',
        party: 2,
        status: ReservationStatus.CONFIRMED,
        source: ReservationSource.WEB,
        note: 'A birthday',
        changeable: true,
      });
      expect(made.number).toMatch(/^RSV-\d{6}$/);

      const row = await prisma.reservation.findUniqueOrThrow({
        where: { id: made.id },
      });
      expect(row.customerId).toBeNull();
      expect(row.phone).toBe('08031234567');
      expect(row.email).toBe(body.email);

      // The confirmation (gate step 6), sent after the commit.
      const mail = sentMail(app).lastTo(body.email);
      expect(mail?.subject).toBe(`Your table at CNC is booked: ${made.number}`);
      expect(mail?.text).toContain('Arrival: 19:00');
      expect(mail?.text).toContain('Party: 2 guests');

      // The website and Reception see it at once (gate step 3).
      expect(await tableStatus('lounge', 'TDS1', made.businessDate)).toBe(
        'RESERVED',
      );
      const listed = await request(server())
        .get(`/api/v1/staff/reservations?date=${made.businessDate}`)
        .set(receptionAuth)
        .expect(200);
      expect(
        (listed.body as { data: { number: string; source: string }[] }).data,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            number: made.number,
            source: ReservationSource.WEB,
          }),
        ]),
      );

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { ref: made.number, action: 'reservation.create' },
      });
      expect(audit).toMatchObject({
        actorKind: 'SYSTEM',
        channel: ReservationSource.WEB,
        staffId: null,
        customerId: null,
      });
    });

    it('answers a retry with the same key with the first booking, once', async () => {
      // A guest's key is scoped to their address: the retry comes from it.
      const key = randomUUID();
      const address = clientAddress();
      const body = guest();
      const first = (await book(body, { key, address }).expect(201))
        .body as Booking;
      const again = (await book(body, { key, address }).expect(201))
        .body as Booking;

      expect(again.id).toBe(first.id);
      expect(
        await prisma.reservation.count({
          where: {
            tableId: await tableId('lounge', 'TDS1'),
            businessDate: new Date(`${body.businessDate}T00:00:00Z`),
          },
        }),
      ).toBe(1);
      expect(sentMail(app).allTo(body.email)).toHaveLength(1);

      const reused = await book({ ...body, party: 3 }, { key, address }).expect(
        409,
      );
      expect(messageOf(reused)).toBe(
        'This Idempotency-Key was already used for a different request.',
      );

      await request(server())
        .post('/api/v1/reservations')
        .set('X-Forwarded-For', clientAddress())
        .send(guest())
        .expect(400);
    });

    it('refuses the guest’s details with the website form’s sentences', async () => {
      expect(sentence(await book(guest({ name: '  ' })).expect(400))).toBe(
        WEB_GUEST_NAME_MESSAGE,
      );
      expect(
        sentence(await book(guest({ phone: '+44 20 7946 0958' })).expect(400)),
      ).toBe(WEB_GUEST_PHONE_MESSAGE);
      expect(sentence(await book(guest({ email: 'ada@' })).expect(400))).toBe(
        WEB_GUEST_EMAIL_MESSAGE,
      );
      expect(sentence(await book(guest({ table: 'NOPE' })).expect(400))).toBe(
        CAPACITY_MESSAGE,
      );
      expect(sentence(await book(guest({ venue: 'roof' })).expect(400))).toBe(
        CAPACITY_MESSAGE,
      );
      // A website number written with 234 and no plus is the site's too.
      const made = (
        await book(guest({ phone: '234 803 123 4567' })).expect(201)
      ).body as Booking;
      expect(
        (await prisma.reservation.findUniqueOrThrow({ where: { id: made.id } }))
          .phone,
      ).toBe('08031234567');
    });

    it('sends a large party to the team, keeps to the places, the grid and the last arrival', async () => {
      expect(sentence(await book(guest({ party: 5 })).expect(400))).toBe(
        bigPartyMessage(5),
      );
      expect(
        sentence(
          await book(guest({ venue: 'dining', table: 'B1', party: 4 })).expect(
            400,
          ),
        ),
      ).toBe(
        'For four or more guests, speak to our team and we will arrange suitable seating.',
      );
      expect(
        sentence(await book(guest({ table: 'TS1', party: 3 })).expect(400)),
      ).toBe(CAPACITY_MESSAGE);
      expect(sentence(await book(guest({ time: '19:15' })).expect(400))).toBe(
        ARRIVAL_SLOT_MESSAGE,
      );
      expect(sentence(await book(guest({ time: '23:30' })).expect(400))).toBe(
        ARRIVAL_SLOT_MESSAGE,
      );
      // 23:00 is the last arrival, and on the grid.
      await book(guest({ time: '23:00' })).expect(201);
    });

    it('answers a locked or seated table in the website’s words, never Reception’s', async () => {
      const id = await tableId('lounge', 'TS2');
      const staff = await prisma.staff.findFirstOrThrow({
        select: { id: true },
      });
      const session = await prisma.tableSession.create({
        data: {
          tableId: id,
          status: TableSessionStatus.LOCKED,
          note: 'Broken leg',
          since: new Date(),
          openedById: staff.id,
        },
      });

      try {
        const refused = await book(guest({ table: 'TS2' })).expect(409);
        expect(messageOf(refused)).toBe(TAKEN_ONLINE_MESSAGE);
      } finally {
        await prisma.tableSession.update({
          where: { id: session.id },
          data: { endedAt: new Date(), closedById: staff.id },
        });
      }
    });

    it('lets one of five guests booking one table and date at once win (the race)', async () => {
      for (let round = 0; round < 3; round++) {
        const date = freshDate();
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            book(guest({ table: 'TDS2', businessDate: date })),
          ),
        );
        const statuses = results.map((r) => r.status).sort();

        expect(statuses).toEqual([201, 409, 409, 409, 409]);
        for (const refused of results.filter((r) => r.status === 409)) {
          expect(messageOf(refused)).toBe(TAKEN_ONLINE_MESSAGE);
        }
        expect(
          await prisma.reservation.count({
            where: {
              tableId: await tableId('lounge', 'TDS2'),
              businessDate: new Date(`${date}T00:00:00Z`),
            },
          }),
        ).toBe(1);
      }
    });

    it('races a website booking against Reception’s for one table: one booking, each refused in its own words', async () => {
      const date = freshDate();
      const id = await tableId('lounge', 'TDS3');
      const [web, desk] = await Promise.all([
        book(guest({ table: 'TDS3', businessDate: date })),
        request(server())
          .post('/api/v1/staff/reservations')
          .set(receptionAuth)
          .set('Idempotency-Key', randomUUID())
          .send({
            name: 'Phone guest',
            phone: '08099998888',
            email: newEmail(),
            tableId: id,
            businessDate: date,
            time: '20:00',
            party: 2,
          }),
      ]);

      expect([web.status, desk.status].sort()).toEqual([201, 409]);
      if (web.status === 409) expect(messageOf(web)).toBe(TAKEN_ONLINE_MESSAGE);
      else
        expect(messageOf(desk)).toBe(
          'This position is already reserved for that date. A booking keeps its table until staff free it.',
        );
    });

    it('is a number per address (429)', async () => {
      const address = clientAddress();
      let last: request.Response | undefined;

      for (let n = 0; n <= BOOKING_ADDRESS_LIMIT; n++) {
        last = await request(server())
          .post('/api/v1/reservations')
          .set('X-Forwarded-For', address)
          .set('Idempotency-Key', randomUUID())
          .send({ ...guest(), name: '' });
      }

      expect(last?.status).toBe(429);
      expect(messageOf(last!)).toBe(TOO_MANY_ATTEMPTS_MESSAGE);
    });

    it('refuses a staff token (403) and a bad token (401) rather than booking as a guest', async () => {
      await book(guest(), { auth: receptionAuth }).expect(403);
      await book(guest(), {
        auth: { Authorization: 'Bearer nonsense' },
      }).expect(401);
    });
  });

  describe('linking bookings to customers (Q35, A15)', () => {
    it('makes a signed-in booking the app’s and the customer’s own, seen only by them', async () => {
      const me = await customer();
      const other = await customer();
      const made = (
        await book(guest({ table: 'TDS4', email: me.email }), {
          auth: me.auth,
        }).expect(201)
      ).body as Booking;

      expect(made.source).toBe(ReservationSource.APP);
      expect(
        (await prisma.reservation.findUniqueOrThrow({ where: { id: made.id } }))
          .customerId,
      ).toBe(me.id);
      expect((await mine(me)).map((b) => b.id)).toEqual([made.id]);
      expect(await mine(other)).toEqual([]);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { ref: made.number, action: 'reservation.create' },
      });
      expect(audit).toMatchObject({
        actorKind: 'CUSTOMER',
        customerId: me.id,
        channel: ReservationSource.APP,
      });
    });

    it('links a guest booking to the customer holding its verified email, and never creates one', async () => {
      const me = await customer();
      const before = await prisma.customer.count();

      const linked = (
        await book(guest({ table: 'TDS5', email: me.email })).expect(201)
      ).body as Booking;
      const stranger = guest({ table: 'TDS5' });
      const unlinked = (await book(stranger).expect(201)).body as Booking;

      expect(
        (
          await prisma.reservation.findUniqueOrThrow({
            where: { id: linked.id },
          })
        ).customerId,
      ).toBe(me.id);
      expect(
        (
          await prisma.reservation.findUniqueOrThrow({
            where: { id: unlinked.id },
          })
        ).customerId,
      ).toBeNull();
      expect(await prisma.customer.count()).toBe(before);
      expect(linked.source).toBe(ReservationSource.WEB);
    });

    it('links Reception’s booking only to a verified email, never to an unverified one', async () => {
      const me = await customer();
      const unverified = newEmail();
      await prisma.customer.create({
        data: {
          memberNo: await drawNumber(prisma, 'customer'),
          name: 'Not yet verified',
          email: unverified,
        },
      });
      const id = await tableId('dining', 'B2');
      const deskBook = (email: string) =>
        request(server())
          .post('/api/v1/staff/reservations')
          .set(receptionAuth)
          .set('Idempotency-Key', randomUUID())
          .send({
            name: 'Phone guest',
            phone: '08011112222',
            email,
            tableId: id,
            businessDate: freshDate(),
            time: '13:00',
            party: 2,
          })
          .expect(201);

      const linked = (await deskBook(me.email)).body as {
        id: string;
        customerId: string | null;
      };
      const notLinked = (await deskBook(unverified)).body as {
        customerId: string | null;
      };

      expect(linked.customerId).toBe(me.id);
      expect(notLinked.customerId).toBeNull();
      expect((await mine(me)).map((b) => b.id)).toContain(linked.id);
    });

    it('collects a guest’s earlier bookings when that email is first proved by a code', async () => {
      const email = newEmail();
      const made = (await book(guest({ table: 'TS3', email })).expect(201))
        .body as Booking;

      expect(
        (await prisma.reservation.findUniqueOrThrow({ where: { id: made.id } }))
          .customerId,
      ).toBeNull();

      const me = await customer(email);

      expect((await mine(me)).map((b) => b.id)).toEqual([made.id]);
    });
  });

  describe('the customer’s change and cancel (Q6)', () => {
    async function myBooking(
      who: Customer,
      overrides: Record<string, unknown> = {},
    ) {
      return (
        await book(guest({ email: who.email, ...overrides }), {
          auth: who.auth,
        }).expect(201)
      ).body as Booking;
    }

    it('changes the date, time and party more than 24 hours ahead, and says so by email', async () => {
      const me = await customer();
      const made = await myBooking(me, { table: 'TS4' });
      const date = freshDate();

      const response = await change(me, made.id, {
        version: made.version,
        businessDate: date,
        time: '20:30',
        party: 1,
      }).expect(200);
      const changed = response.body as Booking;

      expect(changed).toMatchObject({
        id: made.id,
        businessDate: date,
        time: '20:30',
        party: 1,
        tableCode: 'TS4',
        status: ReservationStatus.CONFIRMED,
        version: made.version + 1,
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(sentMail(app).lastTo(me.email)?.subject).toBe(
        `Your CNC booking ${made.number} has changed`,
      );
      expect(await tableStatus('lounge', 'TS4', made.businessDate)).toBe(
        'AVAILABLE',
      );
      expect(await tableStatus('lounge', 'TS4', date)).toBe('RESERVED');

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { ref: made.number, action: 'reservation.change' },
      });
      expect(audit).toMatchObject({ actorKind: 'CUSTOMER', customerId: me.id });
    });

    it('refuses another customer’s booking as not found, and a stale version', async () => {
      const me = await customer();
      const other = await customer();
      const made = await myBooking(me, { table: 'TS5' });

      expect(
        messageOf(
          await change(other, made.id, {
            version: made.version,
            party: 1,
          }).expect(404),
        ),
      ).toBe(CUSTOMER_RESERVATION_NOT_FOUND_MESSAGE);
      expect(
        messageOf(await cancel(other, made.id, made.version).expect(404)),
      ).toBe(CUSTOMER_RESERVATION_NOT_FOUND_MESSAGE);
      expect(messageOf(await cancel(me, 'no-such-id', 0).expect(404))).toBe(
        CUSTOMER_RESERVATION_NOT_FOUND_MESSAGE,
      );
      // The stranger's attempt moved nothing.
      expect(
        (await prisma.reservation.findUniqueOrThrow({ where: { id: made.id } }))
          .version,
      ).toBe(made.version);

      await change(me, made.id, { version: made.version, party: 1 }).expect(
        200,
      );
      expect(
        messageOf(
          await change(me, made.id, { version: made.version, party: 2 }).expect(
            409,
          ),
        ),
      ).toBe(STALE_VERSION_MESSAGE);
    });

    it('answers the change’s problems in the account app’s words', async () => {
      const me = await customer();
      const made = await myBooking(me, { table: 'TS1', party: 2 });
      const v = made.version;

      expect(
        messageOf(
          await change(me, made.id, { version: v, party: 3 }).expect(400),
        ),
      ).toBe(customerCapacityMessage('Lounge table 1', 2));
      expect(
        messageOf(
          await change(me, made.id, { version: v, party: 5 }).expect(400),
        ),
      ).toBe(bigPartyMessage(5));
      expect(
        messageOf(
          await change(me, made.id, { version: v, time: '19:15' }).expect(400),
        ),
      ).toBe(CUSTOMER_ARRIVAL_MESSAGE);
      expect(
        messageOf(
          await change(me, made.id, { version: v, time: '23:30' }).expect(400),
        ),
      ).toBe(CUSTOMER_ARRIVAL_MESSAGE);

      // Another booking holds TS1 on the date asked for.
      const taken = freshDate();
      await book(guest({ table: 'TS1', businessDate: taken })).expect(201);
      expect(
        messageOf(
          await change(me, made.id, { version: v, businessDate: taken }).expect(
            409,
          ),
        ),
      ).toBe(customerTakenMessage('Lounge table 1'));

      // Nothing above changed the booking or its version.
      expect(
        (await prisma.reservation.findUniqueOrThrow({ where: { id: made.id } }))
          .version,
      ).toBe(v);
    });

    it('cancels more than 24 hours ahead, frees the table, emails, and cancels once', async () => {
      const me = await customer();
      const made = await myBooking(me, { table: 'TDS1' });

      const cancelled = (await cancel(me, made.id, made.version).expect(200))
        .body as Booking;
      expect(cancelled).toMatchObject({
        status: ReservationStatus.CANCELLED,
        changeable: false,
      });
      expect(cancelled.cancelledAt).not.toBeNull();
      expect(await tableStatus('lounge', 'TDS1', made.businessDate)).toBe(
        'AVAILABLE',
      );
      expect(sentMail(app).lastTo(me.email)?.subject).toBe(
        `Your CNC booking ${made.number} is cancelled`,
      );

      expect(
        messageOf(await cancel(me, made.id, cancelled.version).expect(409)),
      ).toBe(CANCEL_CONFIRMED_MESSAGE);
      expect(
        messageOf(
          await change(me, made.id, {
            version: cancelled.version,
            party: 1,
          }).expect(409),
        ),
      ).toBe(CHANGE_CONFIRMED_MESSAGE);

      // The freed table books again.
      await book(
        guest({ table: 'TDS1', businessDate: made.businessDate }),
      ).expect(201);
    });

    it('races a customer’s change onto a date against a website booking for it: one wins', async () => {
      for (let round = 0; round < 3; round++) {
        const me = await customer();
        const made = await myBooking(me, { table: 'TDS2' });
        const target = freshDate();
        const [moved, web] = await Promise.all([
          change(me, made.id, { version: made.version, businessDate: target }),
          book(guest({ table: 'TDS2', businessDate: target })),
        ]);

        expect([moved.status, web.status].sort()).toEqual([200, 409]);
        if (moved.status === 409) {
          expect(messageOf(moved)).toBe(customerTakenMessage(made.tableName));
        } else {
          expect(messageOf(web)).toBe(TAKEN_ONLINE_MESSAGE);
        }
        expect(
          await prisma.reservation.count({
            where: {
              tableId: await tableId('lounge', 'TDS2'),
              businessDate: new Date(`${target}T00:00:00Z`),
              status: ReservationStatus.CONFIRMED,
            },
          }),
        ).toBe(1);
      }
    });

    it('lists only the customer’s own, latest first, with changeable from the server', async () => {
      const me = await customer();
      const later = await myBooking(me, {
        table: 'TS2',
        businessDate: dayFromToday(60),
      });
      const sooner = await myBooking(me, {
        table: 'TS2',
        businessDate: dayFromToday(59),
      });

      const list = await mine(me);
      expect(list.map((b) => b.id)).toEqual([later.id, sooner.id]);
      expect(list.every((b) => b.changeable)).toBe(true);
      for (const item of list) {
        expect(Object.keys(item).sort()).toEqual(BOOKING_KEYS);
      }

      await request(server()).get('/api/v1/me/reservations').expect(401);
      await request(server())
        .get('/api/v1/me/reservations')
        .set(receptionAuth)
        .expect(403);
    });
  });

  describe('the 24-hour boundary (Q6), on the server’s clock', () => {
    it('allows a change and a cancel just over 24 hours ahead and refuses them just under, with the app’s words', async () => {
      const me = await customer();
      // Tomorrow at 13:00 in Jos: 25 hours after the suite's noon.
      const tomorrow = dayFromToday(1);
      const changing = (
        await book(
          guest({
            table: 'TDS3',
            businessDate: tomorrow,
            time: '13:00',
            email: me.email,
          }),
          { auth: me.auth },
        ).expect(201)
      ).body as Booking;
      const cancelling = (
        await book(
          guest({
            table: 'TDS4',
            businessDate: tomorrow,
            time: '13:00',
            email: me.email,
          }),
          { auth: me.auth },
        ).expect(201)
      ).body as Booking;
      const start = noon + 25 * HOUR;

      expect(changing.changeableUntil).toBe(
        new Date(start - 24 * HOUR).toISOString(),
      );

      // One minute before the window closes: both allowed. Tokens are
      // minted again at the new time, as a client refreshes.
      jest.setSystemTime(start - 24 * HOUR - MINUTE);
      me.auth = {
        Authorization: `Bearer ${(await tokens.issueTokenPair(me.id, SubjectType.CUSTOMER)).accessToken}`,
      };
      const changed = (
        await change(me, changing.id, {
          version: changing.version,
          party: 3,
        }).expect(200)
      ).body as Booking;
      expect(changed.changeable).toBe(true);

      // One minute after: both refused, and the list says so.
      jest.setSystemTime(start - 24 * HOUR + MINUTE);
      expect(
        messageOf(
          await change(me, changing.id, {
            version: changed.version,
            party: 2,
          }).expect(409),
        ),
      ).toBe(LATE_CHANGE_MESSAGE);
      expect(
        messageOf(
          await cancel(me, cancelling.id, cancelling.version).expect(409),
        ),
      ).toBe(LATE_CHANGE_MESSAGE);
      expect(
        (await mine(me))
          .filter((b) => b.businessDate === tomorrow)
          .map((b) => b.changeable),
      ).toEqual([false, false]);

      // Staff can still cancel inside the window.
      await request(server())
        .post(`/api/v1/staff/reservations/${cancelling.id}/cancel`)
        .set({
          Authorization: `Bearer ${await accessTokenFor(tokens, receptionId)}`,
        })
        .send({ version: cancelling.version })
        .expect(200);
    });

    it('leaves a message waiting, never failing the booking, when mail is not configured', async () => {
      sentMail(app).configured = false;

      try {
        const body = guest({ table: 'TS3' });
        const made = (await book(body).expect(201)).body as Booking;
        const waiting = await prisma.outboundMessage.findUniqueOrThrow({
          where: { dedupeKey: `reservation:${made.id}:confirmed` },
        });

        expect(waiting).toMatchObject({
          status: OutboundMessageStatus.PENDING,
          attempts: 0,
        });
      } finally {
        sentMail(app).configured = true;
      }
    });
  });
});
