/*
 * CNC's inbox, set before the app is built so the walk does not depend on
 * the developer's `.env` (`ConfigModule` never overwrites a value already
 * present; Jest gives each file its own copy of process.env). The same
 * pattern as `enquiries.e2e-spec.ts`.
 */
const INBOX = 'cnc-gate-inbox@cnc.test';

process.env.CNC_CONTACT_EMAIL = INBOX;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  EnquiryKind,
  OutboundMessageStatus,
  ReservationSource,
  ReservationStatus,
  StaffRole,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { CUSTOMER_REFRESH_COOKIE } from '../src/auth/refresh-cookie';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { LATE_CHANGE_MESSAGE } from '../src/reception/reception-messages';
import { createTestApp, sentMail } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';
import { clientAddress } from './staff-sessions';

interface Profile {
  id: string;
  memberNo: string;
  name: string;
  email: string;
}

interface Booking {
  id: string;
  number: string;
  venue: string;
  tableCode: string;
  businessDate: string;
  time: string;
  party: number;
  status: ReservationStatus;
  source: ReservationSource;
  startsAt: string;
  changeable: boolean;
  version: number;
}

interface FloorTable {
  id: string;
  code: string;
  status: string;
  reservations: { id: string; number: string; name: string; time: string }[];
}

interface Availability {
  arrivalTimes: string[];
  tables: { code: string; status: string }[];
}

interface MenuBody {
  categories: { items: { slug: string; priceKobo: number }[] }[];
}

const HOUR = 60 * 60 * 1000;

/**
 * The C6 gate (plan §15, C6), steps 1 to 8, walked against the API in
 * order, as the site and the account app will drive it, with Reception and
 * the Owner on the staff routes beside them. Each step is one test so a
 * failure names its step; they share state and must run in order. The
 * frontend half of the gate (pages under `/cnc`, the inbox itself) is the
 * founder's walk on staging; this is the backend's half.
 *
 * On a database of its own (`createIsolatedDatabase`) seeded with the real
 * rooms, tables, hours and menu (`seedData`). Mail goes through the test
 * harness's `RecordingMailTransport`, so "the email arrives" is read from
 * what the transport was handed. **The clock is controlled**
 * (`fakeDateOnly`): the walk starts at the next 12:00 in Jos, so a 19:00
 * arrival today is open and step 4's check-in falls on its date, and moves
 * forward only in step 5, to put the app booking inside its 24 hours.
 */
describe('the C6 gate (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  let ownerId: string;
  let receptionId: string;

  /** The customer of step 1, carried through the walk. */
  const me = {
    email: `gate-${randomUUID()}@cnc.test`,
    address: clientAddress(),
    cookie: '',
    accessToken: '',
  };
  /** Step 2's website booking, freed in step 4. */
  let webBooking: Booking;
  /** Step 5's app booking. */
  let appBooking: Booking;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);

    fakeDateOnly(nextNoonInJos());

    ownerId = (
      await createStaffAccount(prisma, StaffRole.OWNER, {
        emailPrefix: 'c6-gate',
      })
    ).id;
    receptionId = (
      await createStaffAccount(prisma, StaffRole.RECEPTION, {
        emailPrefix: 'c6-gate',
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
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;
  const today = () => formatIsoDate(watToday(new Date()));
  const dayFromToday = (days: number) =>
    formatIsoDate(addDays(watToday(new Date()), days));
  /** A staff bearer minted at the current (controlled) time. */
  const asStaff = async (staffId: string) => ({
    Authorization: `Bearer ${await accessTokenFor(tokens, staffId)}`,
  });
  const asMe = () => ({ Authorization: `Bearer ${me.accessToken}` });

  const refreshCookieOf = (response: request.Response): string => {
    const line = (
      response.headers['set-cookie'] as unknown as string[] | undefined
    )?.find((cookie) => cookie.startsWith(`${CUSTOMER_REFRESH_COOKIE}=`));

    if (line === undefined) throw new Error('No customer cookie was set.');

    return line.split(';')[0];
  };

  /** A page reload: the app restores its session from the cookie alone. */
  const reload = async (): Promise<Profile> => {
    const response = await request(server())
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-For', me.address)
      .set('Cookie', me.cookie)
      .set('Content-Type', 'application/json')
      .send({})
      .expect(200);
    const body = response.body as { accessToken: string; customer: Profile };

    me.cookie = refreshCookieOf(response);
    me.accessToken = body.accessToken;

    return body.customer;
  };

  const book = (body: Record<string, unknown>, auth = {}) =>
    request(server())
      .post('/api/v1/reservations')
      .set('X-Forwarded-For', clientAddress())
      .set('Idempotency-Key', randomUUID())
      .set(auth)
      .send(body);

  const availability = async (venue: string, date: string) =>
    (
      await request(server())
        .get(`/api/v1/venues/${venue}/availability?date=${date}`)
        .expect(200)
    ).body as Availability;

  const publicStatus = async (venue: string, code: string, date: string) =>
    (await availability(venue, date)).tables.find(
      (table) => table.code === code,
    )?.status;

  /** Reception's floor, read once: one poll of the Reception screen. */
  const floorTable = async (code: string): Promise<FloorTable> => {
    const response = await request(server())
      .get('/api/v1/staff/floor?venue=lounge')
      .set(await asStaff(receptionId))
      .expect(200);
    const table = (response.body as { tables: FloorTable[] }).tables.find(
      (row) => row.code === code,
    );

    if (table === undefined) throw new Error(`No Lounge table ${code}.`);

    return table;
  };

  const myBookings = async () =>
    (
      (
        await request(server())
          .get('/api/v1/me/reservations')
          .set(asMe())
          .expect(200)
      ).body as { data: Booking[] }
    ).data;

  it('1. signs in with an email code, asks a first-timer’s name, and keeps the session on reload', async () => {
    const asked = await request(server())
      .post('/api/v1/auth/code')
      .set('X-Forwarded-For', me.address)
      .send({ email: me.email })
      .expect(200);
    expect(asked.body).toEqual({ sentTo: 'g•••@cnc.test', resendInSec: 30 });

    // The code is read from the email, as a person reads it; it is never in
    // the answer.
    const mail = sentMail(app).lastTo(me.email);
    const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
    expect(code).toBeDefined();
    expect(mail?.subject).toBe(`${code} is your CNC sign-in code`);
    expect(asked.text).not.toContain(code!);

    const verified = await request(server())
      .post('/api/v1/auth/verify')
      .set('X-Forwarded-For', me.address)
      .send({ email: me.email, code })
      .expect(200);
    const session = verified.body as {
      accessToken: string;
      customer: Profile;
      isNew: boolean;
    };

    expect(session.isNew).toBe(true);
    expect(session.customer).toMatchObject({ name: '', email: me.email });
    expect(session.customer.memberNo).toMatch(/^CNC-\d{6}$/);
    expect(verified.text).not.toContain(code!);
    me.cookie = refreshCookieOf(verified);
    me.accessToken = session.accessToken;

    // The cookie is the host-only, Lax one on the auth path (A16).
    const line = (verified.headers['set-cookie'] as unknown as string[]).find(
      (cookie) => cookie.startsWith(`${CUSTOMER_REFRESH_COOKIE}=`),
    )!;
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/Path=\/api\/v1\/auth/);
    expect(line).not.toMatch(/Domain=/i);

    // First-time name capture.
    const named = await request(server())
      .patch('/api/v1/me')
      .set(asMe())
      .send({ name: 'Ada Okafor' })
      .expect(200);
    expect((named.body as Profile).name).toBe('Ada Okafor');

    // Reload: the cookie alone restores the session, and the name stays.
    const restored = await reload();
    expect(restored).toMatchObject({
      id: session.customer.id,
      name: 'Ada Okafor',
      email: me.email,
    });
    const profile = await request(server())
      .get('/api/v1/me')
      .set(asMe())
      .expect(200);
    expect((profile.body as Profile).name).toBe('Ada Okafor');

    // A second sign-in is no longer new.
    await prisma.otpCode.updateMany({
      where: { contact: me.email },
      data: { resendAfter: new Date(Date.now() - 1000) },
    });
    await request(server())
      .post('/api/v1/auth/code')
      .set('X-Forwarded-For', me.address)
      .send({ email: me.email })
      .expect(200);
    const again = await request(server())
      .post('/api/v1/auth/verify')
      .set('X-Forwarded-For', me.address)
      .send({
        email: me.email,
        code: sentMail(app)
          .lastTo(me.email)
          ?.text.match(/\b(\d{6})\b/)?.[1],
      })
      .expect(200);
    expect((again.body as { isNew: boolean }).isNew).toBe(false);
    me.cookie = refreshCookieOf(again);
    me.accessToken = (again.body as { accessToken: string }).accessToken;
  });

  it('2. books a Lounge table from the website', async () => {
    const before = await availability('lounge', today());
    expect(before.arrivalTimes).toContain('19:00');
    expect(before.tables.find((table) => table.code === 'TDS1')?.status).toBe(
      'AVAILABLE',
    );

    // The website, with no session: a guest booking under the customer's
    // email, which links to their account (A15, Q35).
    const response = await book({
      venue: 'lounge',
      table: 'TDS1',
      businessDate: today(),
      time: '19:00',
      party: 2,
      name: 'Ada Okafor',
      phone: '0803 123 4567',
      email: me.email,
      note: 'Window side, please.',
    }).expect(201);
    webBooking = response.body as Booking;

    expect(webBooking).toMatchObject({
      venue: 'lounge',
      tableCode: 'TDS1',
      businessDate: today(),
      time: '19:00',
      party: 2,
      status: ReservationStatus.CONFIRMED,
      source: ReservationSource.WEB,
    });
    expect(webBooking.number).toMatch(/^RSV-\d{6}$/);

    expect(await publicStatus('lounge', 'TDS1', today())).toBe('RESERVED');
    expect((await myBookings()).map((booking) => booking.id)).toContain(
      webBooking.id,
    );
  });

  it('3. shows the booking to Reception within one read of the floor', async () => {
    const table = await floorTable('TDS1');

    expect(table.status).toBe('RESERVED');
    expect(table.reservations).toEqual([
      expect.objectContaining({
        id: webBooking.id,
        number: webBooking.number,
        name: 'Ada Okafor',
        time: '19:00',
      }),
    ]);

    const list = await request(server())
      .get(`/api/v1/staff/reservations?date=${today()}`)
      .set(await asStaff(receptionId))
      .expect(200);
    expect(
      (list.body as { data: { number: string; source: string }[] }).data,
    ).toContainEqual(
      expect.objectContaining({
        number: webBooking.number,
        source: ReservationSource.WEB,
      }),
    );
  });

  it('4. frees the table at Reception, and the website shows it free in one read', async () => {
    const checkedIn = await request(server())
      .post(`/api/v1/staff/reservations/${webBooking.id}/check-in`)
      .set(await asStaff(receptionId))
      .send({ version: webBooking.version })
      .expect(200);
    const session = (
      checkedIn.body as { session: { id: string; version: number } }
    ).session;

    expect(await publicStatus('lounge', 'TDS1', today())).toBe('OCCUPIED');

    const table = await floorTable('TDS1');
    const released = await request(server())
      .post(`/api/v1/staff/tables/${table.id}/release`)
      .set(await asStaff(receptionId))
      .send({ sessionId: session.id, version: session.version })
      .expect(200);
    expect(
      (released.body as { completedReservations: string[] })
        .completedReservations,
    ).toEqual([webBooking.number]);

    expect(await publicStatus('lounge', 'TDS1', today())).toBe('AVAILABLE');
    expect((await floorTable('TDS1')).status).toBe('AVAILABLE');
  });

  it('5. changes the app booking more than 24 hours ahead, and refuses inside 24 hours with the app’s words', async () => {
    const made = await book(
      {
        venue: 'lounge',
        table: 'TDS2',
        businessDate: dayFromToday(3),
        time: '19:00',
        party: 2,
        name: 'Ada Okafor',
        phone: '0803 123 4567',
        email: me.email,
      },
      asMe(),
    ).expect(201);
    appBooking = made.body as Booking;
    expect(appBooking.source).toBe(ReservationSource.APP);
    expect(appBooking.changeable).toBe(true);

    const changed = await request(server())
      .patch(`/api/v1/me/reservations/${appBooking.id}`)
      .set(asMe())
      .send({ time: '20:00', version: appBooking.version })
      .expect(200);
    appBooking = changed.body as Booking;
    expect(appBooking).toMatchObject({
      time: '20:00',
      businessDate: dayFromToday(3),
      status: ReservationStatus.CONFIRMED,
    });
    expect(await publicStatus('lounge', 'TDS2', dayFromToday(3))).toBe(
      'RESERVED',
    );

    // 23 hours before the new start; the app reloads at that time.
    jest.setSystemTime(new Date(appBooking.startsAt).getTime() - 23 * HOUR);
    await reload();

    const [listed] = (await myBookings()).filter(
      (booking) => booking.id === appBooking.id,
    );
    expect(listed.changeable).toBe(false);

    const refused = await request(server())
      .patch(`/api/v1/me/reservations/${appBooking.id}`)
      .set(asMe())
      .send({ time: '21:00', version: appBooking.version })
      .expect(409);
    expect(messageOf(refused)).toBe(
      'Your reservation is less than 24 hours away. Nothing is charged, but please call CNC if you can no longer come.',
    );
    expect(messageOf(refused)).toBe(LATE_CHANGE_MESSAGE);

    const notCancelled = await request(server())
      .post(`/api/v1/me/reservations/${appBooking.id}/cancel`)
      .set(asMe())
      .send({ version: appBooking.version })
      .expect(409);
    expect(messageOf(notCancelled)).toBe(LATE_CHANGE_MESSAGE);

    const unchanged = await prisma.reservation.findUniqueOrThrow({
      where: { id: appBooking.id },
    });
    expect(unchanged).toMatchObject({
      startMinutes: 20 * 60,
      status: ReservationStatus.CONFIRMED,
      version: appBooking.version,
    });
  });

  it('6. emails the confirmation of each booking, and the change', async () => {
    const mail = sentMail(app).allTo(me.email);
    const subjects = mail.map((message) => message.subject);

    expect(subjects).toContain(
      `Your table at CNC is booked: ${webBooking.number}`,
    );
    expect(subjects).toContain(
      `Your table at CNC is booked: ${appBooking.number}`,
    );
    expect(subjects).toContain(
      `Your CNC booking ${appBooking.number} has changed`,
    );

    const confirmation = mail.find(
      (message) =>
        message.subject === `Your table at CNC is booked: ${webBooking.number}`,
    )!;
    expect(confirmation.html).toContain('CHEF NORO CULINARY');
    expect(confirmation.replyTo).toBe(INBOX);

    for (const booking of [webBooking, appBooking]) {
      expect(
        await prisma.outboundMessage.findUniqueOrThrow({
          where: { dedupeKey: `reservation:${booking.id}:confirmed` },
        }),
      ).toMatchObject({
        to: me.email,
        template: 'reservation.confirmed',
        status: OutboundMessageStatus.SENT,
        payload: null,
      });
    }
  });

  it('7. records a contact enquiry and emails it to the CNC inbox', async () => {
    const sender = `guest-${randomUUID()}@example.com`;

    const response = await request(server())
      .post('/api/v1/enquiries')
      .set('X-Forwarded-For', clientAddress())
      .send({
        name: 'Bola Ade',
        email: sender,
        subject: 'Private dinner',
        message: 'Can we book the Lounge for twelve on a Saturday?',
        company: '',
      })
      .expect(204);
    expect(response.text).toBe('');

    const row = await prisma.enquiry.findFirstOrThrow({
      where: { email: sender },
    });
    expect(row).toMatchObject({
      kind: EnquiryKind.CONTACT,
      name: 'Bola Ade',
      subject: 'Private dinner',
    });

    const [mail] = sentMail(app)
      .allTo(INBOX)
      .filter((message) => message.text.includes(sender));
    expect(mail).toBeDefined();
    expect(mail.subject).toBe('CNC enquiry: Private dinner');
    expect(mail.replyTo).toBe(sender);
    expect(mail.text).toContain(
      'Can we book the Lounge for twelve on a Saturday?',
    );

    expect(
      await prisma.outboundMessage.findUniqueOrThrow({
        where: { dedupeKey: `enquiry:${row.id}` },
      }),
    ).toMatchObject({
      to: INBOX,
      template: 'enquiry.contact',
      status: OutboundMessageStatus.SENT,
    });
  });

  it('8. shows a price the Owner changes on the public menu', async () => {
    const menu = async () =>
      (await request(server()).get('/api/v1/menu').expect(200))
        .body as MenuBody;
    const priceOf = (body: MenuBody, slug: string) =>
      body.categories
        .flatMap((category) => category.items)
        .find((item) => item.slug === slug)?.priceKobo;

    const shown = (await menu()).categories.flatMap(
      (category) => category.items,
    );
    expect(shown.length).toBeGreaterThan(0);
    const dish = await prisma.menuItem.findUniqueOrThrow({
      where: { slug: shown[0].slug },
    });
    const newPrice = dish.priceKobo + 50_000;

    await request(server())
      .patch(`/api/v1/staff/menu/${dish.id}`)
      .set(await asStaff(ownerId))
      .send({ priceKobo: newPrice, version: dish.version })
      .expect(200);

    // The site's menu pages and the order page read this one route.
    expect(priceOf(await menu(), dish.slug)).toBe(newPrice);
  });
});
