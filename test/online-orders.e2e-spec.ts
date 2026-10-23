/*
 * CNC's Paystack key and the sweep token for this suite, set before the
 * app is built so nothing depends on the developer's `.env`. The key signs
 * this suite's fake webhooks only: the client is `FakePaystackClient`.
 */
const PAYSTACK_KEY = 'sk_test_cnc_online_orders_e2e_not_a_real_key';
const SWEEP_TOKEN = `sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`;

process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;
process.env.CNC_SWEEP_TOKEN = SWEEP_TOKEN;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CheckoutStatus,
  Department,
  OrderChannel,
  StockLocation,
  StockMovementType,
  SubjectType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { DELETE_WITH_UPCOMING_MESSAGE } from '../src/customers/customer-deletion.service';
import { SWEEP_TOKEN_HEADER } from '../src/internal/sweep-token.guard';
import { PaystackUnavailableError } from '../src/payments/paystack-client';
import { WebhookDispatcherService } from '../src/payments/webhook-dispatcher.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';
import { createTestApp } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import { fakePaystack } from './fake-paystack-client';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { chargeSuccessBody, postSignedWebhook } from './paystack-webhooks';

interface CreatedBody {
  reference: string;
  sums: {
    subtotalKobo: number;
    vatKobo: number;
    deliveryKobo: number;
    totalKobo: number;
  };
}

/**
 * The web order a confirmed payment writes (plan §7.4 step 4, card C7-3)
 * and the checkouts and payments sweeps (§5.5, card C7-5), through HTTP
 * with no real Paystack: the client is the harness's fake, every webhook
 * is signed here with the suite's test key, and a customer "pays" on
 * Paystack's page with `fakePaystack(app).pay(reference)`.
 *
 * On a database of its own with the real seeds and the clock faked from
 * the next noon in Jos, so its sequences, Bar balances and counts are its
 * own and every count below is exact.
 */
describe('online orders on payment, and the payment sweeps (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  let dispatcher: WebhookDispatcherService;
  let food: { id: string; slug: string; name: string; priceKobo: number };
  let drink: { id: string; slug: string; name: string; priceKobo: number };
  let drinkStockId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });
    dispatcher = app.get(WebhookDispatcherService, { strict: false });

    await seedData(prisma);
    fakeDateOnly(nextNoonInJos());

    const online = { active: true, showOnline: true };

    food = await prisma.menuItem.findFirstOrThrow({
      where: {
        ...online,
        department: Department.RESTAURANT,
        choiceOptions: { isEmpty: true },
        priceKobo: { gt: 0 },
      },
      orderBy: { slug: 'asc' },
    });
    drink = await prisma.menuItem.findFirstOrThrow({
      where: {
        ...online,
        department: Department.BAR,
        choiceOptions: { isEmpty: true },
        priceKobo: { gt: 0 },
      },
      orderBy: { slug: 'asc' },
    });
    drinkStockId = (
      await prisma.stockItem.findFirstOrThrow({
        where: { menuItemId: drink.id },
      })
    ).id;
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
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  const address = {
    zone: 'JOS',
    street: '12 Rayfield Road',
    area: 'Rayfield',
    town: 'Jos',
    landmark: 'Opposite the filling station',
  };

  const checkoutBody = (over: Record<string, unknown> = {}) => ({
    lines: [
      { dishId: food.slug, qty: 2 },
      { dishId: drink.slug, qty: 3 },
    ],
    fulfilment: 'DELIVERY',
    address,
    timing: 'ASAP',
    name: 'Ada Okafor',
    phone: '0803 123 4567',
    email: `ada-${randomUUID()}@example.com`,
    note: 'Ring twice',
    ...over,
  });

  const created = async (
    body: Record<string, unknown> = checkoutBody(),
    headers: Record<string, string> = {},
  ) =>
    (
      await request(server())
        .post('/api/v1/checkouts')
        .set('Idempotency-Key', randomUUID())
        .set(headers)
        .send(body)
        .expect(201)
    ).body as CreatedBody;

  const webhook = (body: unknown) => postSignedWebhook(app, body, PAYSTACK_KEY);

  const read = (reference: string) =>
    request(server()).get(`/api/v1/checkouts/${reference}`).expect(200);

  const sweep = (name: 'checkouts' | 'payments', token = SWEEP_TOKEN) =>
    request(server())
      .post(`/api/v1/internal/sweeps/${name}`)
      .set(SWEEP_TOKEN_HEADER, token)
      .set('Content-Length', '0');

  const checkoutRow = (reference: string) =>
    prisma.checkout.findUniqueOrThrow({ where: { reference } });

  /** What one checkout's payment wrote, counted. */
  const written = async (reference: string) => {
    const checkout = await checkoutRow(reference);
    const orders = await prisma.order.count({
      where: { checkout: { reference } },
    });
    const payments = await prisma.payment.count({
      where: { providerRef: reference },
    });
    const online = await prisma.onlineOrder.count({
      where: { paystackReference: reference },
    });
    const order =
      checkout.orderId === null
        ? null
        : await prisma.order.findUniqueOrThrow({
            where: { id: checkout.orderId },
          });
    const movements =
      order === null
        ? 0
        : await prisma.stockMovement.count({ where: { ref: order.number } });
    const audits =
      order === null
        ? 0
        : await prisma.auditLog.count({
            where: { ref: order.number, action: 'online.paid' },
          });

    return { checkout, order, orders, payments, online, movements, audits };
  };

  /** The last value a sequence handed out (null before its first draw). */
  const lastDrawn = async (sequence: string) => {
    const [row] = await prisma.$queryRawUnsafe<
      { last_value: bigint; is_called: boolean }[]
    >(`SELECT last_value, is_called FROM "${sequence}"`);

    return row.is_called ? Number(row.last_value) : null;
  };

  const barBalance = async () =>
    (
      await prisma.stockBalance.findUnique({
        where: {
          stockItemId_location: {
            stockItemId: drinkStockId,
            location: StockLocation.BAR,
          },
        },
      })
    )?.qty ?? 0;

  describe('C7-3: the order a confirmed payment writes', () => {
    it('writes the order, lines, food docket, payment, online order, Bar sale and audit row in one go', async () => {
      const barBefore = await barBalance();
      const body = await created();
      const subtotal = food.priceKobo * 2 + drink.priceKobo * 3;
      const vat = Math.round((subtotal * 750) / 10000);

      // Gate step 1: subtotal + 7.5% VAT + ₦5,000 within Jos (Q33).
      expect(body.sums).toEqual({
        subtotalKobo: subtotal,
        vatKobo: vat,
        deliveryKobo: 500000,
        totalKobo: subtotal + vat + 500000,
      });

      await webhook(
        chargeSuccessBody(body.reference, body.sums.totalKobo),
      ).expect(200);
      await dispatcher.settled();

      const got = await written(body.reference);
      const order = got.order!;

      expect(got.checkout.status).toBe(CheckoutStatus.PAID);
      expect(got).toMatchObject({
        orders: 1,
        payments: 1,
        online: 1,
        movements: 1,
        audits: 1,
      });
      expect(order).toMatchObject({
        department: Department.RESTAURANT,
        channel: OrderChannel.WEB,
        status: 'SETTLED',
        guest: 'Ada Okafor',
        revision: 1,
        vatBps: 750,
        serviceBps: 0,
        notes: 'Ring twice',
        openedById: null,
      });
      expect(order.number).toMatch(/^CNCR-\d{6}$/);
      expect(order.settledAt).not.toBeNull();

      const lines = await prisma.orderLine.findMany({
        where: { orderId: order.id },
        orderBy: { department: 'asc' },
      });

      expect(
        lines.map(({ menuItemId, qty, unitPriceKobo, department }) => ({
          menuItemId,
          qty,
          unitPriceKobo,
          department,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            menuItemId: food.id,
            qty: 2,
            unitPriceKobo: food.priceKobo,
            department: Department.RESTAURANT,
          },
          {
            menuItemId: drink.id,
            qty: 3,
            unitPriceKobo: drink.priceKobo,
            department: Department.BAR,
          },
        ]),
      );

      // The docket carries the food only, marked web with its fulfilment.
      const dockets = await prisma.docket.findMany({
        where: { orderId: order.id },
      });

      expect(dockets).toHaveLength(1);
      expect(dockets[0]).toMatchObject({
        ref: `KOT-${order.number}`,
        revision: 1,
        channel: OrderChannel.WEB,
        fulfilment: 'DELIVERY',
        staffId: null,
        notes: 'Ring twice',
      });
      expect(dockets[0].items).toEqual([
        {
          menuItemId: food.id,
          name: food.name,
          option: '',
          qty: 2,
          unitPriceKobo: food.priceKobo,
        },
      ]);

      const payment = await prisma.payment.findUniqueOrThrow({
        where: { providerRef: body.reference },
      });

      expect(payment).toMatchObject({
        orderId: order.id,
        method: 'ONLINE',
        amountKobo: body.sums.totalKobo,
        reference: body.reference,
        cardBrand: 'Visa',
        cardLast4: '4081',
        staffId: null,
        part: false,
      });
      expect(payment.number).toMatch(/^PAY-\d{6}$/);

      const online = await prisma.onlineOrder.findUniqueOrThrow({
        where: { paystackReference: body.reference },
      });

      expect(online).toMatchObject({
        orderId: order.id,
        checkoutId: got.checkout.id,
        mode: 'WITHIN_JOS',
        fulfilmentStatus: 'RECEIVED',
        feeKobo: 500000,
        contactName: 'Ada Okafor',
        contactPhone: '08031234567',
        addressLandmark: 'Opposite the filling station',
        addressText:
          '12 Rayfield Road, Rayfield, Jos, Landmark: Opposite the filling station',
        timingText: 'As soon as possible, about 90 minutes',
        note: 'Ring twice',
      });
      expect(online.number).toMatch(/^WEB-\d{6}$/);
      expect(order.label).toBe(online.number);

      // Plan §7.4: the Bar may go below zero for a paid web order (Q11
      // seeds no Bar stock), and the movement is WEB_SALE.
      expect(await barBalance()).toBe(barBefore - 3);
      expect(
        await prisma.stockMovement.findFirstOrThrow({
          where: { ref: order.number },
        }),
      ).toMatchObject({
        stockItemId: drinkStockId,
        location: StockLocation.BAR,
        qty: -3,
        type: StockMovementType.WEB_SALE,
        staffId: null,
      });

      expect(
        await prisma.auditLog.findFirstOrThrow({
          where: { ref: order.number, action: 'online.paid' },
        }),
      ).toMatchObject({
        actorKind: 'SYSTEM',
        actorName: 'Online checkout',
        module: 'Online Orders',
        reason: 'Paid online',
      });

      // The confirmation page shows the order number now.
      expect((await read(body.reference)).body).toMatchObject({
        status: 'PAID',
        number: order.number,
        card: 'Visa ending 4081',
      });
    });

    it('shows in the till’s history tagged Online', async () => {
      const body = await created();

      await webhook(
        chargeSuccessBody(body.reference, body.sums.totalKobo),
      ).expect(200);
      await dispatcher.settled();

      const { order } = await written(body.reference);

      expect(
        await prisma.order.count({
          where: { id: order!.id, channel: OrderChannel.WEB },
        }),
      ).toBe(1);
    });

    it('writes the order on the confirmation read when the customer returns before the webhook, and the webhook then changes nothing', async () => {
      const body = await created();

      // Not paid yet: the read asks Paystack, finds nothing, draws nothing.
      const before = await lastDrawn('order_restaurant_no_seq');

      expect((await read(body.reference)).body).toMatchObject({
        status: 'PENDING',
        number: null,
      });
      expect(await lastDrawn('order_restaurant_no_seq')).toBe(before);

      fakePaystack(app).pay(body.reference);

      const paid = (await read(body.reference)).body as { number: string };

      expect(paid).toMatchObject({ status: 'PAID' });
      expect(paid.number).toMatch(/^CNCR-/);

      await webhook(
        chargeSuccessBody(body.reference, body.sums.totalKobo),
      ).expect(200);
      await dispatcher.settled();

      expect(await written(body.reference)).toMatchObject({
        orders: 1,
        payments: 1,
        online: 1,
        movements: 1,
        audits: 1,
      });
    });

    it('sends drinks alone to no kitchen: no docket, revision 0', async () => {
      const body = await created(
        checkoutBody({ lines: [{ dishId: drink.slug, qty: 1 }] }),
      );

      await webhook(
        chargeSuccessBody(body.reference, body.sums.totalKobo),
      ).expect(200);
      await dispatcher.settled();

      const { order } = await written(body.reference);

      expect(order!.revision).toBe(0);
      expect(await prisma.docket.count({ where: { orderId: order!.id } })).toBe(
        0,
      );
    });

    it('writes pickup with no address and no fee, and a scheduled time on the docket', async () => {
      const slots = (
        await request(server())
          .get('/api/v1/ordering/slots?fulfilment=PICKUP')
          .expect(200)
      ).body as { today: string[] };
      const today = formatIsoDate(watToday(new Date()));
      const body = await created(
        checkoutBody({
          fulfilment: 'PICKUP',
          address: undefined,
          timing: 'SCHEDULED',
          date: today,
          time: slots.today[0],
        }),
      );

      await webhook(
        chargeSuccessBody(body.reference, body.sums.totalKobo),
      ).expect(200);
      await dispatcher.settled();

      const { order, checkout } = await written(body.reference);
      const online = await prisma.onlineOrder.findUniqueOrThrow({
        where: { orderId: order!.id },
      });
      const docket = await prisma.docket.findFirstOrThrow({
        where: { orderId: order!.id },
      });

      expect(online).toMatchObject({
        mode: 'PICKUP',
        feeKobo: 0,
        addressStreet: null,
        addressText: '',
      });
      expect(online.scheduledFor).toEqual(checkout.scheduledFor);
      expect(docket.fulfilment).toBe('PICKUP');
      expect(docket.scheduledFor).toEqual(checkout.scheduledFor);
    });

    it('links a signed-in customer, and a guest who ticked Save my details gets an unverified customer and no session', async () => {
      const customer = await prisma.customer.create({
        data: {
          memberNo: await drawNumber(prisma, 'customer'),
          name: 'App Customer',
          email: `app-${randomUUID()}@cnc.test`,
          emailVerifiedAt: new Date(),
        },
      });
      const { accessToken } = await tokens.issueTokenPair(
        customer.id,
        SubjectType.CUSTOMER,
      );
      const app1 = await created(checkoutBody(), {
        Authorization: `Bearer ${accessToken}`,
      });

      await webhook(
        chargeSuccessBody(app1.reference, app1.sums.totalKobo),
      ).expect(200);
      await dispatcher.settled();
      expect((await written(app1.reference)).order!.customerId).toBe(
        customer.id,
      );

      // A paid web order still to be delivered keeps the account (Q36).
      expect(
        messageOf(
          await request(server())
            .delete('/api/v1/me')
            .set('Authorization', `Bearer ${accessToken}`)
            .expect(409),
        ),
      ).toBe(DELETE_WITH_UPCOMING_MESSAGE);

      const email = `saver-${randomUUID()}@example.com`;
      const guest = await created(
        checkoutBody({ email, name: 'Saver Guest', saveDetails: true }),
      );

      await webhook(
        chargeSuccessBody(guest.reference, guest.sums.totalKobo),
      ).expect(200);
      await dispatcher.settled();

      const saved = await prisma.customer.findUniqueOrThrow({
        where: { email },
      });
      const got = await written(guest.reference);

      expect(saved).toMatchObject({
        name: 'Saver Guest',
        emailVerifiedAt: null,
        addressZone: 'JOS',
        addressLandmark: 'Opposite the filling station',
      });
      expect(got.order!.customerId).toBe(saved.id);
      expect(got.checkout.customerId).toBe(saved.id);
      expect(
        await prisma.refreshToken.count({ where: { subjectId: saved.id } }),
      ).toBe(0);

      // A guest who did not tick it, with no verified account: no customer.
      const plain = `plain-${randomUUID()}@example.com`;
      const anon = await created(checkoutBody({ email: plain }));

      await webhook(
        chargeSuccessBody(anon.reference, anon.sums.totalKobo),
      ).expect(200);
      await dispatcher.settled();
      expect((await written(anon.reference)).order!.customerId).toBeNull();
      expect(await prisma.customer.count({ where: { email: plain } })).toBe(0);
    });
  });

  describe('C7-3: races', () => {
    it('settles once when the webhook and the confirmation read arrive at once', async () => {
      for (let round = 0; round < 3; round += 1) {
        const body = await created();

        fakePaystack(app).pay(body.reference);
        await Promise.all([
          webhook(
            chargeSuccessBody(body.reference, body.sums.totalKobo),
          ).expect(200),
          read(body.reference),
          read(body.reference),
        ]);
        await dispatcher.settled();

        expect(await written(body.reference)).toMatchObject({
          orders: 1,
          payments: 1,
          online: 1,
          movements: 1,
          audits: 1,
        });
      }
    });

    it('settles once when two different deliveries for one payment arrive at once', async () => {
      for (let round = 0; round < 3; round += 1) {
        const body = await created();

        await Promise.all([
          webhook(chargeSuccessBody(body.reference, body.sums.totalKobo)),
          webhook(chargeSuccessBody(body.reference, body.sums.totalKobo)),
        ]);
        await dispatcher.settled();

        expect(
          await prisma.paymentEvent.count({
            where: { reference: body.reference },
          }),
        ).toBe(2);
        expect(await written(body.reference)).toMatchObject({
          orders: 1,
          payments: 1,
          online: 1,
          movements: 1,
          audits: 1,
        });
      }
    });
  });

  describe('C7-5: POST /internal/sweeps/checkouts', () => {
    it('is refused without the sweep token', async () => {
      await sweep('checkouts', 'wrong').expect(401);
      await sweep('payments', 'wrong').expect(401);
    });

    it('expires an abandoned checkout with no order number burned, writes the order of one paid without a webhook, and leaves the rest', async () => {
      const abandoned = await created();
      const lost = await created();
      const fresh = await created();
      const past = new Date(Date.now() - 60 * 1000);

      await prisma.checkout.updateMany({
        where: { reference: { in: [abandoned.reference, lost.reference] } },
        data: { expiresAt: past },
      });
      // Paid on Paystack's page; the webhook never came.
      fakePaystack(app).pay(lost.reference);

      const orderNumbersBefore = await lastDrawn('order_restaurant_no_seq');
      const result = (await sweep('checkouts').expect(200)).body as Record<
        string,
        number
      >;

      expect(result).toEqual({
        checked: 2,
        paid: 1,
        held: 0,
        expired: 1,
        unreachable: 0,
      });
      expect((await checkoutRow(abandoned.reference)).status).toBe(
        CheckoutStatus.EXPIRED,
      );
      expect((await checkoutRow(abandoned.reference)).orderId).toBeNull();
      expect((await checkoutRow(fresh.reference)).status).toBe(
        CheckoutStatus.PENDING,
      );
      expect(await written(lost.reference)).toMatchObject({
        orders: 1,
        payments: 1,
        online: 1,
      });
      // Gate step 5: the one paid checkout drew one number; the abandoned
      // one drew none.
      expect(await lastDrawn('order_restaurant_no_seq')).toBe(
        (orderNumbersBefore ?? 0) + 1,
      );

      // A second run finds nothing to do.
      expect((await sweep('checkouts').expect(200)).body).toMatchObject({
        checked: 0,
      });

      // A late payment on the expired checkout is still money taken.
      await webhook(
        chargeSuccessBody(abandoned.reference, abandoned.sums.totalKobo),
      ).expect(200);
      await dispatcher.settled();
      expect(await written(abandoned.reference)).toMatchObject({
        orders: 1,
        payments: 1,
      });
    });

    it('leaves a checkout waiting when Paystack cannot be reached', async () => {
      const body = await created();

      await prisma.checkout.update({
        where: { reference: body.reference },
        data: { expiresAt: new Date(Date.now() - 60 * 1000) },
      });
      fakePaystack(app).failNextVerifyWith = new PaystackUnavailableError();

      expect((await sweep('checkouts').expect(200)).body).toEqual({
        checked: 1,
        paid: 0,
        held: 0,
        expired: 0,
        unreachable: 1,
      });
      expect((await checkoutRow(body.reference)).status).toBe(
        CheckoutStatus.PENDING,
      );

      // The next run expires it.
      expect((await sweep('checkouts').expect(200)).body).toMatchObject({
        expired: 1,
      });
    });

    it('settles once when the sweep and a webhook race', async () => {
      for (let round = 0; round < 3; round += 1) {
        const body = await created();

        await prisma.checkout.update({
          where: { reference: body.reference },
          data: { expiresAt: new Date(Date.now() - 60 * 1000) },
        });
        fakePaystack(app).pay(body.reference);
        await Promise.all([
          sweep('checkouts').expect(200),
          webhook(chargeSuccessBody(body.reference, body.sums.totalKobo)),
        ]);
        await dispatcher.settled();

        expect(await written(body.reference)).toMatchObject({
          orders: 1,
          payments: 1,
          online: 1,
          movements: 1,
        });
      }
    });
  });

  describe('C7-5: POST /internal/sweeps/payments', () => {
    it('handles again a delivery left unprocessed, writes its order, and marks it processed', async () => {
      const body = await created();

      fakePaystack(app).failNextVerifyWith = new PaystackUnavailableError();
      await webhook(
        chargeSuccessBody(body.reference, body.sums.totalKobo),
      ).expect(200);
      await dispatcher.settled();

      const event = await prisma.paymentEvent.findFirstOrThrow({
        where: { reference: body.reference },
      });

      expect(event.processedAt).toBeNull();
      expect((await checkoutRow(body.reference)).status).toBe(
        CheckoutStatus.PENDING,
      );

      // Younger than five minutes: left alone, it may still be in flight.
      await prisma.paymentEvent.update({
        where: { id: event.id },
        data: { createdAt: new Date(Date.now() - 60 * 1000) },
      });
      expect((await sweep('payments').expect(200)).body).toEqual({
        redispatched: 0,
        failed: 0,
      });

      await prisma.paymentEvent.update({
        where: { id: event.id },
        data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
      });

      // Verify unreachable again: kept for the next run.
      fakePaystack(app).failNextVerifyWith = new PaystackUnavailableError();
      expect((await sweep('payments').expect(200)).body).toEqual({
        redispatched: 0,
        failed: 1,
      });

      expect((await sweep('payments').expect(200)).body).toEqual({
        redispatched: 1,
        failed: 0,
      });
      expect(
        (
          await prisma.paymentEvent.findUniqueOrThrow({
            where: { id: event.id },
          })
        ).processedAt,
      ).not.toBeNull();
      expect(await written(body.reference)).toMatchObject({
        orders: 1,
        payments: 1,
        online: 1,
      });

      expect((await sweep('payments').expect(200)).body).toEqual({
        redispatched: 0,
        failed: 0,
      });
    });

    it('holds a reported payment that verify does not confirm', async () => {
      const body = await created();

      fakePaystack(app).failNextVerifyWith = new PaystackUnavailableError();
      await webhook(
        chargeSuccessBody(body.reference, body.sums.totalKobo),
      ).expect(200);
      await dispatcher.settled();
      await prisma.paymentEvent.updateMany({
        where: { reference: body.reference },
        data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
      });
      fakePaystack(app).verifyAnswers.set(body.reference, {
        status: 'failed',
      });

      await sweep('payments').expect(200);

      const held = await checkoutRow(body.reference);

      expect(held.status).toBe(CheckoutStatus.NEEDS_ATTENTION);
      expect(held.orderId).toBeNull();
    });
  });
});
