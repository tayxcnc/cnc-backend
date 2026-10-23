/*
 * CNC's Paystack key, inbox and site address for this suite, set before
 * the app is built so nothing depends on the developer's `.env`. The key
 * signs this suite's fake webhooks only: the client is
 * `FakePaystackClient`, and every refund goes to it, never to Paystack.
 */
const PAYSTACK_KEY = 'sk_test_cnc_order_messages_e2e_not_a_real_key';
const INBOX = 'cnc-order-messages-inbox@cnc.test';
const WEB_URL = 'https://tayxcnc.test/cnc';

process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;
process.env.CNC_CONTACT_EMAIL = INBOX;
process.env.CNC_WEB_URL = WEB_URL;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CustomerNotificationKind,
  Department,
  OnlineFulfilmentStatus,
  StaffRole,
  StockKind,
  StockLocation,
  SubjectType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { formatKobo } from '../src/common/money';
import { CUSTOMER_ORDER_NOT_FOUND_MESSAGE } from '../src/online-orders/online-order-messages';
import { PaystackRefusedError } from '../src/payments/paystack-client';
import { WebhookDispatcherService } from '../src/payments/webhook-dispatcher.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';
import { createTestApp, sentMail } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import { fakePaystack } from './fake-paystack-client';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { chargeSuccessBody, postSignedWebhook } from './paystack-webhooks';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

interface Bell {
  data: {
    id: string;
    title: string;
    detail: string;
    page: string;
    category: string;
    ref?: string;
  }[];
  total: number;
}

interface CustomerOrder {
  number: string;
  onlineNumber: string;
  status: OnlineFulfilmentStatus;
  fulfilment: string;
  zone: string | null;
  address: string;
  timing: string;
  lines: { dishId: string; qty: number; unitKobo: number }[];
  sums: {
    subtotalKobo: number;
    vatKobo: number;
    deliveryKobo: number;
    totalKobo: number;
  };
  card: string | null;
}

/**
 * The customer's order messages (card C7-6) and the online orders' bell
 * items (card C7-7), through HTTP: the receipt (always, Q31), the stage
 * emails and the Order Updates switch, the refund notices, the in-app
 * list, `GET /me/orders` on the stored status, the Cashier's, Kitchen's
 * and managers' bell items, and deletion forgetting the order messages
 * (Q36). On a database of its own with the real seeds and the clock
 * faked from the next noon in Jos; every order is paid by a signed fake
 * webhook.
 */
describe('Online order messages, my orders and the bell (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let dispatcher: WebhookDispatcherService;
  let tokens: CncTokenService;

  const token: Partial<Record<StaffRole, string>> = {};

  let food: { id: string; slug: string; name: string; priceKobo: number };
  let drink: { id: string; slug: string; name: string; priceKobo: number };
  let kitchenStockId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    dispatcher = app.get(WebhookDispatcherService, { strict: false });
    tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);
    fakeDateOnly(nextNoonInJos());

    // The corrections below are far above one manager's daily limit.
    await prisma.settings.update({
      where: { singleton: true },
      data: { dailyLimitOn: false },
    });

    for (const role of [
      StaffRole.MANAGER,
      StaffRole.CASHIER,
      StaffRole.KITCHEN,
      StaffRole.WAITER,
    ]) {
      const account = await createStaffAccount(prisma, role);

      token[role] = await accessTokenFor(tokens, account.id);
    }

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
    // The seeds hold no Kitchen items (Q11): one portion item to enter.
    kitchenStockId = (
      await prisma.stockItem.create({
        data: {
          name: 'Rice',
          kind: StockKind.KITCHEN,
          unit: 'portion',
          pack: 'tray',
          factor: 10,
          minimum: 15,
        },
      })
    ).id;
    // Portions the Kitchen holds, so its entry can take two.
    await prisma.stockBalance.create({
      data: {
        stockItemId: kitchenStockId,
        location: StockLocation.KITCHEN,
        qty: 100,
      },
    });
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
  const auth = (role: StaffRole) => ({
    Authorization: `Bearer ${token[role]!}`,
  });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;
  const mail = () => sentMail(app);

  const address = {
    zone: 'JOS',
    street: '12 Rayfield Road',
    area: 'Rayfield',
    town: 'Jos',
    landmark: 'Opposite the filling station',
  };

  /** A signed-in customer, live and verified, with a token. */
  const customer = async (prefOrderUpdates = true) => {
    const row = await prisma.customer.create({
      data: {
        memberNo: await drawNumber(prisma, 'customer'),
        name: 'Chidi Eze',
        email: `chidi-${randomUUID()}@cnc.test`,
        emailVerifiedAt: new Date(),
        prefOrderUpdates,
      },
    });
    const { accessToken } = await tokens.issueTokenPair(
      row.id,
      SubjectType.CUSTOMER,
    );

    return {
      id: row.id,
      email: row.email!,
      headers: { Authorization: `Bearer ${accessToken}` },
    };
  };

  /**
   * A paid web order of 2 dishes and 3 drinks, for delivery in Jos unless
   * `over` says otherwise; `headers` signs it in as a customer.
   */
  const place = async (
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) => {
    const email =
      (over.email as string | undefined) ?? `ada-${randomUUID()}@example.com`;
    const created = (
      await request(server())
        .post('/api/v1/checkouts')
        .set('Idempotency-Key', randomUUID())
        .set(headers)
        .send({
          lines: [
            { dishId: food.slug, qty: 2 },
            { dishId: drink.slug, qty: 3 },
          ],
          fulfilment: 'DELIVERY',
          address,
          timing: 'ASAP',
          name: 'Ada Okafor',
          phone: '0803 123 4567',
          note: 'Ring twice',
          ...over,
          email,
        })
        .expect(201)
    ).body as { reference: string; sums: { totalKobo: number } };
    const body = chargeSuccessBody(created.reference, created.sums.totalKobo);

    await postSignedWebhook(app, body, PAYSTACK_KEY).expect(200);
    await dispatcher.settled();

    const online = await prisma.onlineOrder.findUniqueOrThrow({
      where: { paystackReference: created.reference },
      include: { order: { select: { number: true } } },
    });

    return {
      id: online.id,
      email,
      number: online.order.number,
      reference: created.reference,
      totalKobo: created.sums.totalKobo,
      body,
    };
  };

  const version = async (id: string) =>
    (
      await request(server())
        .get(`/api/v1/staff/online-orders/${id}`)
        .set(auth(StaffRole.MANAGER))
        .expect(200)
    ).body as { version: number; money: { balanceKobo: number } };

  /** A command on the order's current version. */
  const run = async (
    id: string,
    name: string,
    role: StaffRole,
    body: Record<string, unknown>,
    status = 200,
    key?: string,
  ) => {
    const call = request(server())
      .post(`/api/v1/staff/online-orders/${id}/${name}`)
      .set(auth(role));

    return (key ? call.set('Idempotency-Key', key) : call)
      .send({ version: (await version(id)).version, ...body })
      .expect(status);
  };

  const bell = async (headers: Record<string, string>) =>
    (
      await request(server())
        .get('/api/v1/staff/notifications?pageSize=100')
        .set(headers)
        .expect(200)
    ).body as Bell;

  const items = async (customerId: string) =>
    prisma.customerNotification.findMany({
      where: { customerId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  describe('the receipt (Q31)', () => {
    it('emails a guest the website’s receipt once, however often the payment is reported', async () => {
      const placed = await place();
      const receipts = mail().allTo(placed.email);

      expect(receipts).toHaveLength(1);
      expect(receipts[0].subject).toBe(
        `Your CNC order is in: ${placed.number}`,
      );

      const vat = (kobo: number) => Math.round((kobo * 750) / 10000);
      const subtotal = food.priceKobo * 2 + drink.priceKobo * 3;
      const naira = formatKobo;
      const text = receipts[0].text;

      expect(text).toContain('Thank you, Ada.');
      expect(text).toContain('Your order is in.');
      expect(text).toContain(
        'Delivering to: 12 Rayfield Road, Rayfield, Jos, Landmark: ' +
          'Opposite the filling station',
      );
      expect(text).toContain('Paid with: Visa ending 4081');
      expect(text).toContain(`2 × ${food.name}: ${naira(food.priceKobo * 2)}`);
      expect(text).toContain(`Subtotal: ${naira(subtotal)}`);
      expect(text).toContain(`VAT (7.5%): ${naira(vat(subtotal))}`);
      expect(text).toContain('Delivery, Within Jos: ₦5,000.00');
      expect(text).toContain(`Total paid: ${naira(placed.totalKobo)}`);
      // A guest has no account to track it in.
      expect(text).not.toContain('Track this order');
      expect(text).toContain('Call CNC on 0802 218 8797.');

      // The same delivery again, and the confirmation read: no second receipt.
      await postSignedWebhook(app, placed.body, PAYSTACK_KEY).expect(200);
      await dispatcher.settled();
      await request(server())
        .get(`/api/v1/checkouts/${placed.reference}`)
        .expect(200);
      expect(mail().allTo(placed.email)).toHaveLength(1);
    });

    it('emails a signed-in customer even with Order Updates off, links the tracker, and lists the order in the app', async () => {
      const me = await customer(false);
      const placed = await place({ email: me.email }, me.headers);
      const [receipt] = mail().allTo(me.email);

      expect(receipt.subject).toBe(`Your CNC order is in: ${placed.number}`);
      expect(receipt.text).toContain(
        `Track this order in your account: ${WEB_URL}/account#order/${placed.number}`,
      );
      expect(await items(me.id)).toEqual([
        expect.objectContaining({
          kind: CustomerNotificationKind.ORDER,
          title: `Order ${placed.number} received`,
          body: `${food.name}, ${drink.name}.`,
          link: `/account#order/${placed.number}`,
        }),
      ]);
    });

    it('writes "Pickup at CNC" with CNC’s address and a free pickup line', async () => {
      const placed = await place({
        fulfilment: 'PICKUP',
        address: undefined,
      });
      const [receipt] = mail().allTo(placed.email);

      expect(receipt.text).toContain(
        'Pickup: Pickup at CNC, 7A Hospital Place, opposite Water Board, ' +
          'Jos, Plateau State, Nigeria',
      );
      expect(receipt.text).toContain('Pickup: Free');
    });
  });

  describe('the stages (Q31: Order Updates)', () => {
    it('tells a guest on its way, and writes nothing to email for preparing or delivered', async () => {
      const placed = await place();

      await run(placed.id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.PREPARING,
      });
      expect(mail().allTo(placed.email)).toHaveLength(1);

      await run(placed.id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.ON_THE_WAY,
      });

      const onWay = mail().allTo(placed.email);

      expect(onWay).toHaveLength(2);
      expect(onWay[1].subject).toBe(
        `Your CNC order ${placed.number} is on its way`,
      );
      expect(onWay[1].text).toContain(
        'Your order is on its way to 12 Rayfield Road, Rayfield, Jos, ' +
          'Landmark: Opposite the filling station.',
      );

      // The current stage again changes nothing and sends nothing.
      await run(placed.id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.ON_THE_WAY,
      });
      await run(placed.id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.DELIVERED,
      });
      expect(mail().allTo(placed.email)).toHaveLength(2);
    });

    it('writes every stage to the app, and emails ready only while Order Updates is on', async () => {
      const me = await customer(false);
      const placed = await place(
        { email: me.email, fulfilment: 'PICKUP', address: undefined },
        me.headers,
      );

      for (const status of [
        OnlineFulfilmentStatus.PREPARING,
        OnlineFulfilmentStatus.READY,
      ]) {
        await run(placed.id, 'status', StaffRole.CASHIER, { status });
      }

      expect(mail().allTo(me.email)).toHaveLength(1);
      expect((await items(me.id)).map((item) => item.title)).toEqual([
        `Order ${placed.number} received`,
        `Order ${placed.number} is being prepared`,
        `Order ${placed.number} is ready for pickup`,
      ]);

      // Switched on, a manager's correction back and the Cashier's move
      // forward again send the ready email.
      await prisma.customer.update({
        where: { id: me.id },
        data: { prefOrderUpdates: true },
      });
      await run(placed.id, 'correct-status', StaffRole.MANAGER, {
        status: OnlineFulfilmentStatus.PREPARING,
        reason: 'Marked ready too soon',
      });
      await run(placed.id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.READY,
      });

      const ready = mail().allTo(me.email);

      expect(ready).toHaveLength(2);
      expect(ready[1].subject).toBe(
        `Your CNC order ${placed.number} is ready for pickup`,
      );
      expect(ready[1].text).toContain(
        'Your order is ready for pickup at CNC, 7A Hospital Place, ' +
          'opposite Water Board, Jos, Plateau State.',
      );
    });
  });

  describe('cancellations and refunds', () => {
    it('always tells a cancellation, then the card refund once Paystack accepts it', async () => {
      const me = await customer(false);
      const placed = await place({ email: me.email }, me.headers);

      await run(placed.id, 'cancel', StaffRole.MANAGER, {
        reason: 'Kitchen closed early',
      });

      const cancelled = mail().allTo(me.email);

      expect(cancelled).toHaveLength(2);
      expect(cancelled[1].subject).toBe(
        `Your CNC order ${placed.number} is cancelled`,
      );

      const key = randomUUID();

      await run(
        placed.id,
        'balance',
        StaffRole.MANAGER,
        { method: 'PAYSTACK', reason: 'Order cancelled' },
        200,
        key,
      );

      const refunded = mail().allTo(me.email);

      expect(refunded).toHaveLength(3);
      expect(refunded[2].subject).toBe(
        `Refund for your CNC order ${placed.number}`,
      );
      expect(refunded[2].text).toContain(
        `to your card (Visa ending 4081) for order ${placed.number}.`,
      );
      expect((await items(me.id)).map((item) => item.title)).toEqual([
        `Order ${placed.number} received`,
        `Order ${placed.number} cancelled`,
        `Refund for order ${placed.number}`,
      ]);
    });

    it('tells a Cash refund when it is recorded, and nothing for a card refund Paystack refused', async () => {
      const placed = await place();

      await run(placed.id, 'edit', StaffRole.MANAGER, {
        lines: [
          { menuItemId: food.id, qty: 2 },
          { menuItemId: drink.id, qty: 2 },
        ],
        reason: 'One drink was out',
      });

      fakePaystack(app).failNextRefundWith = new PaystackRefusedError(
        400,
        'Transaction has been fully reversed',
      );
      await run(
        placed.id,
        'balance',
        StaffRole.MANAGER,
        { method: 'PAYSTACK', reason: 'One drink was out' },
        502,
        randomUUID(),
      );
      expect(mail().allTo(placed.email)).toHaveLength(1);

      await run(
        placed.id,
        'balance',
        StaffRole.MANAGER,
        { method: 'CASH', reason: 'Rider gave the change back' },
        200,
        randomUUID(),
      );

      const notices = mail().allTo(placed.email);
      const bill = (drinks: number) => {
        const subtotal = food.priceKobo * 2 + drink.priceKobo * drinks;

        return subtotal + Math.round((subtotal * 750) / 10000);
      };
      const back = bill(3) - bill(2);

      expect(notices).toHaveLength(2);
      expect(notices[1].text).toContain(
        `CNC has given you back ${formatKobo(back)} in cash for order ` +
          `${placed.number}.`,
      );
    });
  });

  describe('GET /me/orders', () => {
    it('lists only the customer’s own orders, on the stored stage and as edited', async () => {
      const me = await customer();
      const other = await customer();
      const first = await place({ email: me.email }, me.headers);
      const second = await place(
        { email: me.email, fulfilment: 'PICKUP', address: undefined },
        me.headers,
      );
      const theirs = await place({ email: other.email }, other.headers);

      const list = (
        await request(server())
          .get('/api/v1/me/orders')
          .set(me.headers)
          .expect('Cache-Control', 'no-store')
          .expect(200)
      ).body as { data: CustomerOrder[]; total: number };

      expect(list.total).toBe(2);
      expect(list.data.map((row) => row.number)).toEqual([
        second.number,
        first.number,
      ]);
      expect(list.data[1]).toMatchObject({
        status: OnlineFulfilmentStatus.RECEIVED,
        fulfilment: 'DELIVERY',
        zone: 'JOS',
        address:
          '12 Rayfield Road, Rayfield, Jos, Landmark: Opposite the filling station',
        card: 'Visa ending 4081',
        sums: { deliveryKobo: 500000, totalKobo: first.totalKobo },
      });
      expect(list.data[0]).toMatchObject({
        fulfilment: 'PICKUP',
        zone: null,
        sums: { deliveryKobo: 0 },
      });

      await run(first.id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.PREPARING,
      });
      await run(first.id, 'edit', StaffRole.MANAGER, {
        lines: [{ menuItemId: food.id, qty: 2 }],
        reason: 'No drinks left',
      });

      const tracked = (
        await request(server())
          .get(`/api/v1/me/orders/${first.number}`)
          .set(me.headers)
          .expect(200)
      ).body as CustomerOrder;
      const subtotal = food.priceKobo * 2;
      const vat = Math.round((subtotal * 750) / 10000);

      expect(tracked).toMatchObject({
        number: first.number,
        status: OnlineFulfilmentStatus.PREPARING,
        lines: [{ dishId: food.slug, qty: 2, unitKobo: food.priceKobo }],
        sums: {
          subtotalKobo: subtotal,
          vatKobo: vat,
          deliveryKobo: 500000,
          totalKobo: subtotal + vat + 500000,
        },
      });

      for (const number of [theirs.number, 'CNCR-999999']) {
        const missing = await request(server())
          .get(`/api/v1/me/orders/${number}`)
          .set(me.headers)
          .expect(404);

        expect(messageOf(missing)).toBe(CUSTOMER_ORDER_NOT_FOUND_MESSAGE);
      }

      await request(server()).get('/api/v1/me/orders').expect(401);
      await request(server())
        .get('/api/v1/me/orders')
        .set(auth(StaffRole.CASHIER))
        .expect(403);
    });
  });

  describe('the bell (C7-7)', () => {
    it('shows the Cashier an active order until it is completed', async () => {
      const placed = await place();
      const id = `online:${placed.id}`;

      expect(
        (await bell(auth(StaffRole.CASHIER))).data.find(
          (item) => item.id === id,
        ),
      ).toEqual({
        id,
        title: 'Online Order · Paid',
        detail: `${placed.number} · Ada Okafor`,
        page: 'online',
        category: 'Fulfilment',
      });

      for (const status of [
        OnlineFulfilmentStatus.PREPARING,
        OnlineFulfilmentStatus.ON_THE_WAY,
      ]) {
        await run(placed.id, 'status', StaffRole.CASHIER, { status });
      }

      expect(
        (await bell(auth(StaffRole.CASHIER))).data.find(
          (item) => item.id === id,
        )?.title,
      ).toBe('Online Order · Out for Delivery');

      await run(placed.id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.DELIVERED,
      });

      const after = await bell(auth(StaffRole.CASHIER));

      expect(after.data.map((item) => item.id)).not.toContain(id);
      // Managers and the Kitchen do not get the Cashier's item.
      for (const role of [StaffRole.MANAGER, StaffRole.KITCHEN]) {
        expect(
          (await bell(auth(role))).data.some((item) =>
            item.id.startsWith('online:'),
          ),
        ).toBe(false);
      }
    });

    it('rings the Kitchen and managers for a new web docket until the kitchen enters it', async () => {
      const placed = await place();
      const ref = `KOT-${placed.number}`;
      const find = async (role: StaffRole) =>
        (await bell(auth(role))).data.find((item) => item.ref === ref);

      for (const role of [StaffRole.KITCHEN, StaffRole.MANAGER]) {
        expect(await find(role)).toEqual({
          id: `docket:${ref}:1`,
          title: 'New Web Docket',
          detail: `${ref} · As soon as possible`,
          page: 'kitchen',
          category: 'Kitchen',
          ref,
        });
      }

      expect(await find(StaffRole.CASHIER)).toBeUndefined();
      expect(await find(StaffRole.WAITER)).toBeUndefined();

      await request(server())
        .put(`/api/v1/staff/kitchen/entries/${ref}`)
        .set(auth(StaffRole.KITCHEN))
        .send({ lines: [{ stockItemId: kitchenStockId, qty: 2 }] })
        .expect(200);

      expect(await find(StaffRole.KITCHEN)).toBeUndefined();

      // Drinks alone send the kitchen nothing to ring for.
      const drinks = await request(server())
        .post('/api/v1/checkouts')
        .set('Idempotency-Key', randomUUID())
        .send({
          lines: [{ dishId: drink.slug, qty: 1 }],
          fulfilment: 'PICKUP',
          timing: 'ASAP',
          name: 'Bar Guest',
          phone: '0803 123 4567',
          email: `bar-${randomUUID()}@example.com`,
        })
        .expect(201);
      const created = drinks.body as {
        reference: string;
        sums: { totalKobo: number };
      };

      await postSignedWebhook(
        app,
        chargeSuccessBody(created.reference, created.sums.totalKobo),
        PAYSTACK_KEY,
      ).expect(200);
      await dispatcher.settled();

      const order = await prisma.onlineOrder.findUniqueOrThrow({
        where: { paystackReference: created.reference },
        include: { order: { select: { number: true } } },
      });

      expect(
        (await bell(auth(StaffRole.KITCHEN))).data.some(
          (item) => item.ref === `KOT-${order.order.number}`,
        ),
      ).toBe(false);
    });

    it('stops ringing for a cancelled order’s docket', async () => {
      const placed = await place();
      const ref = `KOT-${placed.number}`;

      await run(placed.id, 'cancel', StaffRole.MANAGER, {
        reason: 'Customer called to cancel',
      });

      expect(
        (await bell(auth(StaffRole.KITCHEN))).data.some(
          (item) => item.ref === ref,
        ),
      ).toBe(false);
    });

    it('shows managers a checkout held for a wrong amount, and nobody else', async () => {
      const created = (
        await request(server())
          .post('/api/v1/checkouts')
          .set('Idempotency-Key', randomUUID())
          .send({
            lines: [{ dishId: food.slug, qty: 1 }],
            fulfilment: 'PICKUP',
            timing: 'ASAP',
            name: 'Held Guest',
            phone: '0803 123 4567',
            email: `held-${randomUUID()}@example.com`,
          })
          .expect(201)
      ).body as { reference: string; sums: { totalKobo: number } };

      await postSignedWebhook(
        app,
        chargeSuccessBody(created.reference, 100),
        PAYSTACK_KEY,
      ).expect(200);
      await dispatcher.settled();

      const checkout = await prisma.checkout.findUniqueOrThrow({
        where: { reference: created.reference },
      });
      const id = `attention:${checkout.id}`;
      const item = (await bell(auth(StaffRole.MANAGER))).data.find(
        (one) => one.id === id,
      );

      expect(item).toMatchObject({
        title: 'Checkout Needs Attention',
        page: 'online',
        category: 'Payment',
      });
      expect(item!.detail).toContain('Held Guest · ');
      expect(item!.detail).toContain(checkout.attentionReason!);

      for (const role of [
        StaffRole.CASHIER,
        StaffRole.KITCHEN,
        StaffRole.WAITER,
      ]) {
        expect((await bell(auth(role))).data.some((one) => one.id === id)).toBe(
          false,
        );
      }

      expect(mail().lastTo(INBOX)?.subject).toBe(
        `Online payment needs attention: ${created.reference}`,
      );
    });
  });

  describe('deleting the account (Q36)', () => {
    it('forgets the order messages of a completed order', async () => {
      const me = await customer();
      const placed = await place({ email: me.email }, me.headers);

      for (const status of [
        OnlineFulfilmentStatus.PREPARING,
        OnlineFulfilmentStatus.ON_THE_WAY,
        OnlineFulfilmentStatus.DELIVERED,
      ]) {
        await run(placed.id, 'status', StaffRole.CASHIER, { status });
      }

      const keyed = {
        dedupeKey: { startsWith: `online:${placed.id}:` },
      };

      expect(await prisma.outboundMessage.count({ where: keyed })).toBe(2);

      await request(server()).delete('/api/v1/me').set(me.headers).expect(204);

      const rows = await prisma.outboundMessage.findMany({ where: keyed });

      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.to === '' && row.payload === null)).toBe(
        true,
      );
      expect(await items(me.id)).toEqual([]);
    });
  });
});
