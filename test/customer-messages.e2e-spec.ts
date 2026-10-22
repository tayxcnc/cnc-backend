/*
 * The sweep token and CNC's inbox, set before the app is built so the suite
 * does not depend on the developer's `.env` (`ConfigModule` never
 * overwrites a value already present; Jest gives each file its own copy of
 * process.env).
 */
const SWEEP_TOKEN = `sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const INBOX = 'cnc-inbox@cnc.test';

process.env.CNC_SWEEP_TOKEN = SWEEP_TOKEN;
process.env.CNC_CONTACT_EMAIL = INBOX;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CustomerNotificationKind,
  OutboundMessageStatus,
  StaffRole,
  SubjectType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import {
  addDays,
  formatIsoDate,
  parseIsoDate,
} from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { CustomerService } from '../src/customers/customer.service';
import { SWEEP_TOKEN_HEADER } from '../src/internal/sweep-token.guard';
import {
  MESSAGE_MAX_ATTEMPTS,
  OutboundMessagesService,
} from '../src/mail/outbound-messages.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { bookingStart } from '../src/reception/reservation-rules';
import { createTestApp, sentMail } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';
import { clientAddress } from './staff-sessions';

interface NotificationItem {
  id: string;
  at: string;
  kind: CustomerNotificationKind;
  title: string;
  body: string;
  link: string | null;
  unread: boolean;
}

interface NotificationPage {
  data: NotificationItem[];
  page: number;
  pageSize: number;
  total: number;
  unread: number;
  notificationsReadAt: string | null;
}

interface Booking {
  id: string;
  number: string;
  tableName: string;
  businessDate: string;
  time: string;
  version: number;
}

interface RemindersSweep {
  reminded: number;
  emailed: number;
  switchedOff: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const newEmail = () => `messages-${randomUUID()}@cnc.test`;

/**
 * The customer's messages (card C6-8) through HTTP and against Postgres:
 * the in-app list (`GET /me/notifications`, `POST /me/notifications/read`)
 * written by the booking events; the reminders sweep
 * (`POST /internal/sweeps/reminders`, Q32); and the messages sweep's
 * backoff and attempts cap (`POST /internal/sweeps/messages`). Mail goes
 * to the harness's recording transport.
 *
 * On a database of its own, seeded with the real rooms and hours, with
 * only `Date` faked from the next 12:00 in Jos and moved forward only, so
 * a reminder's 24 hours and a retry's backoff are crossed exactly. Every
 * booking takes a date of its own; sweeps are global, so a test asserts
 * the bookings and messages it made, never a bare total.
 */
describe('customer messages (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  let customers: CustomerService;
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

    fakeDateOnly(nextNoonInJos());

    const reception = await createStaffAccount(prisma, StaffRole.RECEPTION, {
      emailPrefix: 'customer-messages',
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

  afterEach(() => {
    sentMail(app).configured = true;
    sentMail(app).failWith = undefined;
    sentMail(app).hold = undefined;
  });

  const server = () => app.getHttpServer();
  /** A date of the test's own, days ahead of the faked today. */
  const freshDate = () => {
    nextDay += 2;

    return formatIsoDate(addDays(watToday(new Date()), nextDay));
  };
  const startOf = (booking: Pick<Booking, 'businessDate' | 'time'>) => {
    const [hours, minutes] = booking.time.split(':').map(Number);

    return bookingStart(
      parseIsoDate(booking.businessDate)!,
      hours * 60 + minutes,
    ).getTime();
  };
  /** Every customer this suite made, so moving the clock renews their tokens. */
  const signedIn: Customer[] = [];

  /**
   * Move the faked clock forward, then renew every session: an access
   * token lasts 15 minutes of the clock it was signed on.
   */
  const moveClockTo = async (instant: number) => {
    expect(instant).toBeGreaterThanOrEqual(Date.now());
    jest.setSystemTime(instant);

    receptionAuth = {
      Authorization: `Bearer ${await accessTokenFor(tokens, receptionId)}`,
    };

    for (const who of signedIn) {
      const pair = await tokens.issueTokenPair(who.id, SubjectType.CUSTOMER);
      who.auth = { Authorization: `Bearer ${pair.accessToken}` };
    }
  };

  interface Customer {
    id: string;
    email: string;
    auth: { Authorization: string };
  }

  /** A verified customer with a session, made directly. */
  async function customer(email = newEmail()): Promise<Customer> {
    const { id } = await prisma.$transaction((tx) =>
      customers.findOrCreateVerified(tx, email),
    );
    const pair = await tokens.issueTokenPair(id, SubjectType.CUSTOMER);
    const who = {
      id,
      email,
      auth: { Authorization: `Bearer ${pair.accessToken}` },
    };

    signedIn.push(who);

    return who;
  }

  const book = async (
    overrides: Record<string, unknown> = {},
    auth: Record<string, string> = {},
  ) =>
    (
      await request(server())
        .post('/api/v1/reservations')
        .set('X-Forwarded-For', clientAddress())
        .set('Idempotency-Key', randomUUID())
        .set(auth)
        .send({
          venue: 'lounge',
          table: 'TDS1',
          businessDate: freshDate(),
          time: '19:00',
          party: 2,
          name: 'Ada Okafor',
          phone: '0803 123 4567',
          email: newEmail(),
          ...overrides,
        })
        .expect(201)
    ).body as Booking;

  const notifications = async (who: Customer) =>
    (
      await request(server())
        .get('/api/v1/me/notifications')
        .set(who.auth)
        .expect(200)
    ).body as NotificationPage;

  const sweep = (name: 'reminders' | 'messages') =>
    request(server())
      .post(`/api/v1/internal/sweeps/${name}`)
      .set(SWEEP_TOKEN_HEADER, SWEEP_TOKEN)
      .send()
      .expect(200);

  const reminderSent = async (id: string) =>
    (
      await prisma.reservation.findUniqueOrThrow({
        where: { id },
        select: { reminderSentAt: true },
      })
    ).reminderSentAt;

  const remindersTo = (email: string) =>
    sentMail(app)
      .allTo(email)
      .filter((mail) => mail.subject.startsWith('See you soon at CNC'));

  describe('the in-app list', () => {
    it('welcomes a new account, lists newest first in its own shape, and marks read on the server’s clock', async () => {
      const me = await customer();
      const first = await notifications(me);

      expect(Object.keys(first).sort()).toEqual([
        'data',
        'notificationsReadAt',
        'page',
        'pageSize',
        'total',
        'unread',
      ]);
      expect(first).toMatchObject({
        page: 1,
        pageSize: 20,
        total: 1,
        unread: 1,
        notificationsReadAt: null,
      });
      expect(Object.keys(first.data[0]).sort()).toEqual([
        'at',
        'body',
        'id',
        'kind',
        'link',
        'title',
        'unread',
      ]);
      expect(first.data[0]).toMatchObject({
        kind: CustomerNotificationKind.ACCOUNT,
        title: 'Welcome to CNC',
        body: 'Your orders and your table reservations now live in one place.',
        link: null,
        unread: true,
      });

      // A second sign-in is not a second welcome.
      await customer(me.email);
      expect((await notifications(me)).total).toBe(1);

      const booking = await book({ email: me.email }, me.auth);
      const listed = await notifications(me);

      expect(listed.total).toBe(2);
      expect(listed.unread).toBe(2);
      expect(listed.data[0]).toMatchObject({
        kind: CustomerNotificationKind.BOOKING,
        title: 'Table reserved',
        body: `${booking.tableName}, Lounge, ${new Intl.DateTimeFormat(
          'en-GB',
          {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          },
        )
          .format(parseIsoDate(booking.businessDate)!)
          .replace(/,/g, '')} at 19:00.`,
        link: '/account#reservations',
        unread: true,
      });

      const before = Date.now();
      const read = await request(server())
        .post('/api/v1/me/notifications/read')
        .set(me.auth)
        .expect(200);
      expect(read.headers['cache-control']).toBe('no-store');
      expect(Object.keys(read.body as object)).toEqual(['notificationsReadAt']);
      // The server's (faked) clock, not the database's or the phone's.
      const readAt = Date.parse(
        (read.body as { notificationsReadAt: string }).notificationsReadAt,
      );
      expect(readAt).toBeGreaterThanOrEqual(before);
      expect(readAt).toBeLessThanOrEqual(Date.now());

      const afterRead = await notifications(me);
      expect(afterRead.unread).toBe(0);
      expect(afterRead.data.every((item) => !item.unread)).toBe(true);

      await moveClockTo(Date.now() + MINUTE);
      await request(server())
        .post(`/api/v1/me/reservations/${booking.id}/cancel`)
        .set(me.auth)
        .send({ version: booking.version })
        .expect(200);

      const cancelled = await notifications(me);
      expect(cancelled.unread).toBe(1);
      expect(cancelled.data[0]).toMatchObject({
        title: 'Reservation cancelled',
        unread: true,
      });
    });

    it('lists a change by the customer, and a Reception booking linked by a verified email (Q35)', async () => {
      const me = await customer();
      const booking = await book({ email: me.email, table: 'TDS2' }, me.auth);

      await request(server())
        .patch(`/api/v1/me/reservations/${booking.id}`)
        .set(me.auth)
        .send({ time: '20:00', version: booking.version })
        .expect(200);

      const lounge = await prisma.diningTable.findFirstOrThrow({
        where: { code: 'TDS3', venue: { slug: 'lounge' } },
      });
      await request(server())
        .post('/api/v1/staff/reservations')
        .set(receptionAuth)
        .set('Idempotency-Key', randomUUID())
        .send({
          name: 'Phone guest',
          phone: '08011112222',
          email: me.email,
          tableId: lounge.id,
          businessDate: freshDate(),
          time: '13:00',
          party: 2,
        })
        .expect(201);

      const titles = (await notifications(me)).data.map((item) => item.title);
      expect(titles).toEqual([
        'Table reserved',
        'Reservation changed',
        'Table reserved',
        'Welcome to CNC',
      ]);
      expect((await notifications(me)).data[1].body).toContain('at 20:00.');
    });

    it('tells the guest by email and in-app when Reception cancels their booking', async () => {
      const me = await customer();
      // A guest booking, linked to the customer by its verified email (Q35).
      const booking = await book({ email: me.email, table: 'TS1' });

      await request(server())
        .post(`/api/v1/staff/reservations/${booking.id}/cancel`)
        .set(receptionAuth)
        .send({ version: booking.version })
        .expect(200);

      const mail = sentMail(app).lastTo(me.email);
      expect(mail?.subject).toBe(
        `Your CNC booking ${booking.number} is cancelled`,
      );
      // CNC's number as the website shows it, not the stored digits.
      expect(mail?.text).toContain('please call CNC on 0802 218 8797.');
      expect(
        await prisma.outboundMessage.findUniqueOrThrow({
          where: { dedupeKey: `reservation:${booking.id}:cancelled` },
        }),
      ).toMatchObject({ status: OutboundMessageStatus.SENT, to: me.email });
      expect((await notifications(me)).data[0].title).toBe(
        'Reservation cancelled',
      );
    });

    it('tells the guest by email and in-app when Reception changes their booking’s party', async () => {
      const me = await customer();
      const booking = await book({ email: me.email, table: 'TS2' });

      const changed = await request(server())
        .patch(`/api/v1/staff/reservations/${booking.id}`)
        .set(receptionAuth)
        .send({ party: 1, version: booking.version })
        .expect(200);
      const version = (changed.body as { version: number }).version;

      expect(sentMail(app).lastTo(me.email)?.subject).toBe(
        `Your CNC booking ${booking.number} has changed`,
      );
      expect(
        await prisma.outboundMessage.findUniqueOrThrow({
          where: { dedupeKey: `reservation:${booking.id}:changed:${version}` },
        }),
      ).toMatchObject({ status: OutboundMessageStatus.SENT, to: me.email });
      expect((await notifications(me)).data[0].title).toBe(
        'Reservation changed',
      );
    });

    it('writes nothing in-app for a guest booking, and nobody else sees a customer’s list', async () => {
      const booking = await book();

      expect(
        await prisma.customerNotification.count({
          where: { dedupeKey: { startsWith: `reservation:${booking.id}:` } },
        }),
      ).toBe(0);

      const me = await customer();
      const other = await customer();
      await book({ email: me.email, table: 'TDS2' }, me.auth);
      expect((await notifications(other)).total).toBe(1);
    });

    it('is for customers: 401 without a token, 403 with a staff token', async () => {
      await request(server()).get('/api/v1/me/notifications').expect(401);
      await request(server()).post('/api/v1/me/notifications/read').expect(401);
      await request(server())
        .get('/api/v1/me/notifications')
        .set(receptionAuth)
        .expect(403);
    });
  });

  describe('the reminders sweep (Q32)', () => {
    it('reminds a guest by email once, 24 hours before, and not a minute earlier', async () => {
      const booking = await book();
      const email = (
        await prisma.reservation.findUniqueOrThrow({
          where: { id: booking.id },
        })
      ).email;
      const due = startOf(booking) - 24 * HOUR;

      expect(await reminderSent(booking.id)).toBeNull();

      await moveClockTo(due - MINUTE);
      await sweep('reminders');
      expect(await reminderSent(booking.id)).toBeNull();
      expect(remindersTo(email)).toHaveLength(0);

      await moveClockTo(due);
      const swept = (await sweep('reminders')).body as RemindersSweep;
      expect(swept.reminded).toBeGreaterThanOrEqual(1);
      expect(swept.emailed).toBeGreaterThanOrEqual(1);

      const stamped = (await reminderSent(booking.id))!.getTime();
      expect(stamped).toBeGreaterThanOrEqual(due);
      expect(stamped).toBeLessThan(due + MINUTE);

      const [mail] = remindersTo(email);
      expect(mail.subject).toBe(`See you soon at CNC: ${booking.number}`);
      expect(mail.text).toContain('Your table in the Lounge is booked for ');
      expect(mail.text).toContain(
        ' at 19:00. Your table is yours for your whole visit.',
      );
      expect(mail.replyTo).toBe(INBOX);

      await sweep('reminders');
      await moveClockTo(due + HOUR);
      await sweep('reminders');
      expect(remindersTo(email)).toHaveLength(1);
    });

    it('sends none for a booking made less than 24 hours ahead', async () => {
      const now = Date.now();
      // Tomorrow, at a time under 24 hours away and on the grid.
      const tomorrow = formatIsoDate(addDays(watToday(new Date(now)), 1));
      let time = '08:00';

      for (let minutes = 23 * 60; minutes >= 8 * 60; minutes -= 30) {
        const text = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

        if (startOf({ businessDate: tomorrow, time: text }) - now < 24 * HOUR) {
          time = text;
          break;
        }
      }

      const email = newEmail();
      const booking = await book({
        businessDate: tomorrow,
        time,
        table: 'TS1',
        email,
      });

      // Stamped as handled when it was made, so the sweep passes it by.
      const stamped = (await reminderSent(booking.id))!.getTime();
      expect(stamped).toBeGreaterThanOrEqual(now);
      expect(stamped).toBeLessThan(now + MINUTE);

      await moveClockTo(Math.max(Date.now(), startOf(booking) - HOUR));
      await sweep('reminders');
      expect(remindersTo(email)).toHaveLength(0);
    });

    it('gives a customer who switched reminders off the in-app item only', async () => {
      const me = await customer();
      await prisma.customer.update({
        where: { id: me.id },
        data: { prefBookingReminders: false },
      });
      const booking = await book({ email: me.email, table: 'TDS2' }, me.auth);

      await moveClockTo(startOf(booking) - 24 * HOUR);
      const swept = (await sweep('reminders')).body as RemindersSweep;

      expect(swept.switchedOff).toBeGreaterThanOrEqual(1);
      expect(await reminderSent(booking.id)).not.toBeNull();
      expect(remindersTo(me.email)).toHaveLength(0);
      expect((await notifications(me)).data[0]).toMatchObject({
        title: 'See you soon',
        kind: CustomerNotificationKind.BOOKING,
      });

      // Switched on, a customer gets the email and the item.
      const you = await customer();
      const yours = await book({ email: you.email, table: 'TDS3' }, you.auth);

      await moveClockTo(startOf(yours) - 24 * HOUR);
      await sweep('reminders');
      expect(remindersTo(you.email)).toHaveLength(1);
      expect((await notifications(you)).data[0].title).toBe('See you soon');
    });

    it('does not remind a cancelled booking', async () => {
      const email = newEmail();
      const booking = await book({ email });

      await request(server())
        .post(`/api/v1/staff/reservations/${booking.id}/cancel`)
        .set(receptionAuth)
        .send({ version: booking.version })
        .expect(200);

      await moveClockTo(startOf(booking) - 24 * HOUR);
      await sweep('reminders');
      expect(remindersTo(email)).toHaveLength(0);
      expect(await reminderSent(booking.id)).toBeNull();
    });

    it('reminds again for a new date after Reception moves a reminded booking', async () => {
      const email = newEmail();
      // A table of its own: the new date is chosen here, not by freshDate.
      const booking = await book({ email, table: 'TS2' });

      await moveClockTo(startOf(booking) - 24 * HOUR);
      await sweep('reminders');
      expect(remindersTo(email)).toHaveLength(1);

      const current = await prisma.reservation.findUniqueOrThrow({
        where: { id: booking.id },
      });
      const later = formatIsoDate(addDays(current.businessDate, 4));
      await request(server())
        .patch(`/api/v1/staff/reservations/${booking.id}`)
        .set(receptionAuth)
        .send({ businessDate: later, version: current.version })
        .expect(200);
      expect(await reminderSent(booking.id)).toBeNull();

      await moveClockTo(
        startOf({ businessDate: later, time: '19:00' }) - 24 * HOUR,
      );
      await sweep('reminders');
      expect(remindersTo(email)).toHaveLength(2);
      expect(remindersTo(email)[1].text).toContain(
        new Intl.DateTimeFormat('en-GB', {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        }).format(parseIsoDate(later)!),
      );
    });

    it('reminds once when two sweeps run at the same moment (three rounds)', async () => {
      for (let round = 0; round < 3; round++) {
        const email = newEmail();
        const booking = await book({ email });

        await moveClockTo(startOf(booking) - 24 * HOUR);
        const runs = await Promise.all([
          sweep('reminders'),
          sweep('reminders'),
        ]);

        expect(
          runs.reduce(
            (sum, run) => sum + (run.body as RemindersSweep).emailed,
            0,
          ),
        ).toBeGreaterThanOrEqual(1);
        expect(remindersTo(email)).toHaveLength(1);
        expect(
          await prisma.outboundMessage.count({
            where: {
              dedupeKey: { startsWith: `reservation:${booking.id}:reminder:` },
            },
          }),
        ).toBe(1);
      }
    });

    it('refuses the sweep without its token', async () => {
      await request(server())
        .post('/api/v1/internal/sweeps/reminders')
        .send()
        .expect(401);
      await request(server())
        .post('/api/v1/internal/sweeps/reminders')
        .set(SWEEP_TOKEN_HEADER, 'wrong')
        .send()
        .expect(401);
    });
  });

  describe('the messages sweep: backoff and the attempts cap', () => {
    const messageFor = (bookingId: string) =>
      prisma.outboundMessage.findUniqueOrThrow({
        where: { dedupeKey: `reservation:${bookingId}:confirmed` },
      });

    it('waits 5 minutes after a failed send, then 30, before trying again', async () => {
      sentMail(app).failWith = new Error('Rejected by Resend: test refusal');
      const email = newEmail();
      const before = Date.now();
      const booking = await book({ email });
      const first = await messageFor(booking.id);

      expect(first).toMatchObject({
        status: OutboundMessageStatus.FAILED,
        attempts: 1,
      });
      // 5 minutes from the failed send, on the server's clock.
      const firstWait = first.retryAfter!.getTime();
      expect(firstWait).toBeGreaterThanOrEqual(before + 5 * MINUTE);
      expect(firstWait).toBeLessThanOrEqual(Date.now() + 5 * MINUTE);

      // Inside the backoff the sweep leaves it alone.
      await sweep('messages');
      await moveClockTo(firstWait - 1000);
      await sweep('messages');
      expect((await messageFor(booking.id)).attempts).toBe(1);

      // Past it, a second attempt, failing again: 30 minutes this time.
      await moveClockTo(firstWait);
      const secondAt = Date.now();
      await sweep('messages');
      const second = await messageFor(booking.id);
      expect(second).toMatchObject({
        status: OutboundMessageStatus.FAILED,
        attempts: 2,
      });
      const secondWait = second.retryAfter!.getTime();
      expect(secondWait).toBeGreaterThanOrEqual(secondAt + 30 * MINUTE);
      expect(secondWait).toBeLessThanOrEqual(Date.now() + 30 * MINUTE);

      sentMail(app).failWith = undefined;
      await moveClockTo(secondWait - 1000);
      await sweep('messages');
      expect((await messageFor(booking.id)).attempts).toBe(2);
      expect(sentMail(app).allTo(email)).toHaveLength(0);

      await moveClockTo(secondWait);
      await sweep('messages');
      expect(await messageFor(booking.id)).toMatchObject({
        status: OutboundMessageStatus.SENT,
        attempts: 3,
        retryAfter: null,
        payload: null,
      });
      expect(sentMail(app).allTo(email)).toHaveLength(1);
    });

    it(`gives a message up after ${MESSAGE_MAX_ATTEMPTS} failed attempts and never tries it again`, async () => {
      sentMail(app).failWith = new Error('Rejected by Resend: test refusal');
      const email = newEmail();
      const booking = await book({ email });

      await moveClockTo((await messageFor(booking.id)).retryAfter!.getTime());
      await sweep('messages');
      await moveClockTo((await messageFor(booking.id)).retryAfter!.getTime());
      await sweep('messages');

      expect(await messageFor(booking.id)).toMatchObject({
        status: OutboundMessageStatus.FAILED,
        attempts: MESSAGE_MAX_ATTEMPTS,
        payload: null,
        retryAfter: null,
        lastError: 'Rejected by Resend: test refusal',
      });

      sentMail(app).failWith = undefined;
      await moveClockTo(Date.now() + 60 * MINUTE);
      await sweep('messages');
      expect((await messageFor(booking.id)).attempts).toBe(
        MESSAGE_MAX_ATTEMPTS,
      );
      expect(sentMail(app).allTo(email)).toHaveLength(0);
    });

    it('sends once when a sweep runs while the request’s own send is still in flight', async () => {
      // Queued while mail is down, so the request's dispatch sent nothing.
      sentMail(app).configured = false;
      const email = newEmail();
      const booking = await book({ email });
      const { id } = await messageFor(booking.id);
      sentMail(app).configured = true;

      // A slow provider: every send waits until released.
      let release: () => void = () => undefined;
      sentMail(app).hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const outbound = app.get(OutboundMessagesService, { strict: false });

      const dispatching = outbound.dispatch(id);
      // The dispatch has claimed the message and is waiting on the send.
      for (
        let tries = 0;
        (await messageFor(booking.id)).attempts < 1;
        tries++
      ) {
        if (tries > 200) throw new Error('The dispatch never claimed.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const sweeping = outbound.sweep(new Date());
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await Promise.all([dispatching, sweeping]);

      expect(sentMail(app).allTo(email)).toHaveLength(1);
      expect(await messageFor(booking.id)).toMatchObject({
        status: OutboundMessageStatus.SENT,
        attempts: 1,
        retryAfter: null,
      });
    });

    it('spends no attempt and sets no backoff while mail is not configured', async () => {
      sentMail(app).configured = false;
      const email = newEmail();
      const booking = await book({ email });

      await sweep('messages');
      expect(await messageFor(booking.id)).toMatchObject({
        status: OutboundMessageStatus.PENDING,
        attempts: 0,
        retryAfter: null,
        lastError: 'Mail is not configured.',
      });

      sentMail(app).configured = true;
      await sweep('messages');
      expect((await messageFor(booking.id)).status).toBe(
        OutboundMessageStatus.SENT,
      );
      expect(sentMail(app).allTo(email)).toHaveLength(1);
    });
  });
});
