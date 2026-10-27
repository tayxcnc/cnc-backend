const PAYSTACK_KEY = 'sk_test_cnc_push_customer_e2e_not_a_real_key';

process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  OnlineFulfilmentStatus,
  PushMessageStatus,
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
import { WebhookDispatcherService } from '../src/payments/webhook-dispatcher.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { PushQueueService } from '../src/push/push-queue.service';
import { ReservationRemindersService } from '../src/reception/reservation-reminders.service';
import { bookingStart } from '../src/reception/reservation-rules';
import { createTestApp, pushSender } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { addDevice, fcmPrefix } from './push-devices';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';
import { clientAddress } from './staff-sessions';
import { JOS_DELIVERY, placePaidWebOrder, webDish } from './web-orders';

const HOUR = 60 * 60 * 1000;

/**
 * The customer's pushes (C10, spec §1.1, PC1 to PC9), through the real
 * commands: who gets which, what Order Updates and Reservation Reminders
 * silence (and what they never do), the bookings a customer made for
 * themselves pushing nothing, and a legitimate repeat pushing again.
 *
 * On a database of its own with the real seeds, the clock faked from the
 * next noon in Jos. Each customer holds one device under a prefix of their
 * own, so a test reads its sends by prefix.
 */
describe('Customer pushes (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  let dispatcher: WebhookDispatcherService;
  let dishSlug: string;

  const token: Partial<Record<StaffRole, string>> = {};

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });
    dispatcher = app.get(WebhookDispatcherService, { strict: false });

    await seedData(prisma);
    fakeDateOnly(nextNoonInJos());

    // A cancellation's refund is far above one manager's daily limit.
    await prisma.settings.update({
      where: { singleton: true },
      data: { dailyLimitOn: false },
    });

    for (const role of [
      StaffRole.MANAGER,
      StaffRole.CASHIER,
      StaffRole.RECEPTION,
    ]) {
      const account = await createStaffAccount(prisma, role, {
        emailPrefix: 'push-customer',
      });

      token[role] = await accessTokenFor(tokens, account.id);
    }

    dishSlug = (await webDish(prisma)).slug;
  }, 120_000);

  afterAll(async () => {
    jest.useRealTimers();
    await dispatcher?.settled();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const staff = (role: StaffRole) => ({
    Authorization: `Bearer ${token[role]!}`,
  });

  /** A verified customer with a session and one device. */
  const customer = async (
    prefs: { prefOrderUpdates?: boolean; prefBookingReminders?: boolean } = {},
  ) => {
    const email = `push-customer-${randomUUID()}@cnc.test`;
    const { id } = await prisma.$transaction((tx) =>
      app
        .get(CustomerService, { strict: false })
        .findOrCreateVerified(tx, email),
    );

    await prisma.customer.update({ where: { id }, data: prefs });

    const pair = await tokens.issueTokenPair(id, SubjectType.CUSTOMER);
    const prefix = fcmPrefix();

    await addDevice(prisma, { customerId: id }, `${prefix}-phone`);

    return {
      id,
      email,
      prefix,
      auth: { Authorization: `Bearer ${pair.accessToken}` },
    };
  };

  type Customer = Awaited<ReturnType<typeof customer>>;

  /** The titles of the pushes a customer's device received, in order. */
  const titles = (who: Customer) =>
    pushSender(app)
      .sentTo(who.prefix)
      .map(({ payload }) => payload.title);

  const rows = (who: Customer) =>
    prisma.pushMessage.findMany({
      where: { customerId: who.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  // ------------------------------------------------------------ the orders

  const onlineVersion = async (id: string) =>
    (
      (
        await request(server())
          .get(`/api/v1/staff/online-orders/${id}`)
          .set(staff(StaffRole.MANAGER))
          .expect(200)
      ).body as { version: number }
    ).version;

  const run = async (
    id: string,
    command: string,
    role: StaffRole,
    body: Record<string, unknown>,
    key?: string,
  ) => {
    const call = request(server())
      .post(`/api/v1/staff/online-orders/${id}/${command}`)
      .set(staff(role));

    return (key ? call.set('Idempotency-Key', key) : call)
      .send({ version: await onlineVersion(id), ...body })
      .expect(200);
  };

  const stage = (id: string, status: OnlineFulfilmentStatus) =>
    run(id, 'status', StaffRole.CASHIER, { status });

  describe('the orders (PC1 to PC5)', () => {
    it('pushes preparing, ready and a correction back into a stage, with Order Updates on', async () => {
      const me = await customer();
      const order = await placePaidWebOrder(
        app,
        PAYSTACK_KEY,
        dishSlug,
        me.auth,
      );

      // The receipt pushes nothing: the customer has just paid on screen.
      expect(titles(me)).toEqual([]);

      await stage(order.id, OnlineFulfilmentStatus.PREPARING);
      await stage(order.id, OnlineFulfilmentStatus.READY);
      await run(order.id, 'correct-status', StaffRole.MANAGER, {
        status: OnlineFulfilmentStatus.PREPARING,
        reason: 'Marked ready too soon',
      });
      await stage(order.id, OnlineFulfilmentStatus.READY);

      expect(titles(me)).toEqual([
        `Order ${order.number} is being prepared`,
        `Order ${order.number} is ready for pickup`,
        `Order ${order.number} is being prepared`,
        `Order ${order.number} is ready for pickup`,
      ]);

      const sent = pushSender(app).sentTo(me.prefix);

      expect(sent[1].payload).toMatchObject({
        body: 'Come to the counter to collect it.',
        link: `/account#order/${order.number}`,
        tag: `order:${order.id}`,
        urgent: true,
        renotify: true,
        ref: null,
      });
      expect(sent[1].options.urgency).toBe('high');

      // Collected: the customer is part of it, so nothing.
      await stage(order.id, OnlineFulfilmentStatus.COLLECTED);
      expect(titles(me)).toHaveLength(4);
      expect(
        (await rows(me)).every((row) => row.status === PushMessageStatus.SENT),
      ).toBe(true);
    });

    it('pushes "on its way" for a delivery', async () => {
      const me = await customer();
      const order = await placePaidWebOrder(
        app,
        PAYSTACK_KEY,
        dishSlug,
        me.auth,
        JOS_DELIVERY,
      );

      await stage(order.id, OnlineFulfilmentStatus.PREPARING);
      await stage(order.id, OnlineFulfilmentStatus.ON_THE_WAY);
      await stage(order.id, OnlineFulfilmentStatus.DELIVERED);

      expect(titles(me)).toEqual([
        `Order ${order.number} is being prepared`,
        `Order ${order.number} is on its way`,
      ]);
    });

    it('silences the stages with Order Updates off, never the cancellation or the refund', async () => {
      const me = await customer({ prefOrderUpdates: false });
      const first = await placePaidWebOrder(
        app,
        PAYSTACK_KEY,
        dishSlug,
        me.auth,
      );

      await stage(first.id, OnlineFulfilmentStatus.PREPARING);
      await stage(first.id, OnlineFulfilmentStatus.READY);
      expect(titles(me)).toEqual([]);
      expect(await rows(me)).toEqual([]);

      const second = await placePaidWebOrder(
        app,
        PAYSTACK_KEY,
        dishSlug,
        me.auth,
      );

      await run(second.id, 'cancel', StaffRole.MANAGER, {
        reason: 'Kitchen closed early',
      });
      await run(
        second.id,
        'balance',
        StaffRole.MANAGER,
        { method: 'CASH', reason: 'Order cancelled' },
        randomUUID(),
      );
      // The controller sends the refund's messages after the commit.

      expect(titles(me)).toEqual([
        `Order ${second.number} was cancelled`,
        `Refund for order ${second.number}`,
      ]);

      const refund = pushSender(app).sentTo(me.prefix)[1].payload;

      // No amount, no method.
      expect(refund.body).toBe(
        'A refund has been issued. Open your account for the details.',
      );
      expect(refund.body).not.toMatch(/₦|NGN|cash/i);
    });
  });

  // ----------------------------------------------------------- the bookings

  let nextDay = 2;
  /** A date of the test's own, days ahead, so no two bookings meet. */
  const freshDate = () =>
    formatIsoDate(addDays(watToday(new Date()), nextDay++));

  const tableId = async (code: string) =>
    (
      await prisma.diningTable.findFirstOrThrow({
        where: { code, venue: { slug: 'dining' } },
        select: { id: true },
      })
    ).id;

  /** Reception books for a customer, by the customer's verified email. */
  const deskBook = async (who: Customer, code: string, date: string) =>
    (
      await request(server())
        .post('/api/v1/staff/reservations')
        .set(staff(StaffRole.RECEPTION))
        .set('Idempotency-Key', randomUUID())
        .send({
          name: 'Phone guest',
          phone: '08011112222',
          email: who.email,
          tableId: await tableId(code),
          businessDate: date,
          time: '13:00',
          party: 2,
        })
        .expect(201)
    ).body as { id: string; version: number; customerId: string | null };

  /** The customer books in the app, for themselves. */
  const appBook = async (who: Customer, date: string) =>
    (
      await request(server())
        .post('/api/v1/reservations')
        .set('X-Forwarded-For', clientAddress())
        .set('Idempotency-Key', randomUUID())
        .set(who.auth)
        .send({
          venue: 'lounge',
          table: 'TDS1',
          businessDate: date,
          time: '19:00',
          party: 2,
          name: 'Ada Okafor',
          phone: '0803 123 4567',
          email: who.email,
        })
        .expect(201)
    ).body as { id: string; version: number };

  const bookingVersion = async (id: string) =>
    (await prisma.reservation.findUniqueOrThrow({ where: { id } })).version;

  describe('the bookings (PC6 to PC9)', () => {
    it('pushes a booking Reception made for the customer, and each change staff make', async () => {
      const me = await customer();
      const date = freshDate();
      const made = await deskBook(me, 'B2', date);

      expect(made.customerId).toBe(me.id);
      expect(titles(me)).toEqual(['Table reserved']);
      expect(pushSender(app).sentTo(me.prefix)[0].payload).toMatchObject({
        body: expect.stringMatching(
          /^Your table at CNC is booked for [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} at 13:00\.$/,
        ) as string,
        link: '/account#reservations',
        tag: `reservation:${made.id}`,
      });

      for (const time of ['14:00', '15:00']) {
        await request(server())
          .patch(`/api/v1/staff/reservations/${made.id}`)
          .set(staff(StaffRole.RECEPTION))
          .send({ version: await bookingVersion(made.id), time })
          .expect(200);
      }

      expect(titles(me)).toEqual([
        'Table reserved',
        'Reservation changed',
        'Reservation changed',
      ]);
      expect(pushSender(app).sentTo(me.prefix)[2].payload.body).toContain(
        'at 15:00.',
      );

      await request(server())
        .post(`/api/v1/staff/reservations/${made.id}/cancel`)
        .set(staff(StaffRole.RECEPTION))
        .send({ version: await bookingVersion(made.id) })
        .expect(200);

      expect(titles(me)).toEqual([
        'Table reserved',
        'Reservation changed',
        'Reservation changed',
        'Reservation cancelled',
      ]);
    });

    it('pushes nothing for a booking, change or cancel the customer made themselves', async () => {
      const me = await customer();
      const made = await appBook(me, freshDate());

      await request(server())
        .patch(`/api/v1/me/reservations/${made.id}`)
        .set(me.auth)
        .send({ version: await bookingVersion(made.id), time: '20:00' })
        .expect(200);
      await request(server())
        .post(`/api/v1/me/reservations/${made.id}/cancel`)
        .set(me.auth)
        .send({ version: await bookingVersion(made.id) })
        .expect(200);

      expect(titles(me)).toEqual([]);
      expect(await rows(me)).toEqual([]);
    });

    /** The reminders sweep, run at 23 hours before the booking. */
    const remindAt = async (id: string) => {
      const row = await prisma.reservation.findUniqueOrThrow({
        where: { id },
      });
      const start = bookingStart(row.businessDate, row.startMinutes);

      await app
        .get(ReservationRemindersService, { strict: false })
        .sweep(new Date(start.getTime() - 23 * HOUR));
    };

    it('queues the reminder without sending it; the push sweep delivers it', async () => {
      const me = await customer();
      const date = freshDate();
      const made = await appBook(me, date);

      await remindAt(made.id);

      const [reminder] = await rows(me);

      expect(reminder).toMatchObject({
        event: 'reservation.reminder',
        status: PushMessageStatus.PENDING,
        attempts: 0,
        title: 'See you soon',
      });
      // It lasts until the booking starts.
      expect(reminder.expiresAt.getTime()).toBe(
        bookingStart(parseIsoDate(date)!, 19 * 60).getTime(),
      );
      expect(titles(me)).toEqual([]);

      await app.get(PushQueueService, { strict: false }).sweep(new Date());
      expect(titles(me)).toEqual(['See you soon']);
    });

    it('queues no reminder with Reservation Reminders off', async () => {
      const me = await customer({ prefBookingReminders: false });
      const made = await appBook(me, freshDate());

      await remindAt(made.id);

      expect(
        await prisma.reservation.findUniqueOrThrow({ where: { id: made.id } }),
      ).toMatchObject({ reminderSentAt: expect.any(Date) as Date });
      expect(await rows(me)).toEqual([]);
    });
  });
});
