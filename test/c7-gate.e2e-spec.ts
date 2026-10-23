/*
 * CNC's Paystack key, the sweep token and CNC's inbox for this walk, set
 * before the app is built so nothing depends on the developer's `.env`.
 * The key signs this walk's fake webhooks only: the client is
 * `FakePaystackClient`, so no test card is charged and no refund leaves.
 */
const PAYSTACK_KEY = 'sk_test_cnc_c7_gate_e2e_not_a_real_key';
const SWEEP_TOKEN = `sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const INBOX = 'cnc-c7-gate-inbox@cnc.test';

process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;
process.env.CNC_SWEEP_TOKEN = SWEEP_TOKEN;
process.env.CNC_CONTACT_EMAIL = INBOX;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CheckoutStatus,
  Department,
  OnlineFulfilmentStatus,
  OnlineRefundStatus,
  StaffRole,
  StockLocation,
  StockMovementType,
  SubjectType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { SWEEP_TOKEN_HEADER } from '../src/internal/sweep-token.guard';
import { WebhookDispatcherService } from '../src/payments/webhook-dispatcher.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';
import { createTestApp, sentMail } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import { type FakePaystackClient, fakePaystack } from './fake-paystack-client';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { chargeSuccessBody, postSignedWebhook } from './paystack-webhooks';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

interface Sums {
  subtotalKobo: number;
  vatKobo: number;
  deliveryKobo: number;
  totalKobo: number;
}

interface Detail {
  id: string;
  orderNumber: string;
  fulfilmentStatus: OnlineFulfilmentStatus;
  version: number;
  money: { totalKobo: number; paidKobo: number; balanceKobo: number };
  refunds: { amountKobo: number; status: OnlineRefundStatus }[];
}

const MINUTE = 60 * 1000;

/**
 * The C7 gate (plan §15, C7), steps 1 to 6, walked against the API in
 * order, as the website, the account app and the staff app will drive it,
 * with Paystack replaced by `FakePaystackClient` and its webhooks signed
 * with this walk's test key. What only the real Paystack can show stays
 * the founder's on staging: the test card on Paystack's page, and the
 * refund in the test dashboard (step 4).
 *
 * On a database of its own with the real seeds and the clock faked from
 * the next noon in Jos, so the walk never crosses a business day and its
 * sequences are its own.
 */
describe('The C7 gate walk: online ordering and Paystack (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let dispatcher: WebhookDispatcherService;
  let paystack: FakePaystackClient;

  let tokens: CncTokenService;
  const token: Partial<Record<StaffRole, string>> = {};
  const staffId: Partial<Record<StaffRole, string>> = {};
  let customer: { id: string; email: string; headers: Record<string, string> };

  /**
   * Fresh access tokens for the staff and the customer, as their apps'
   * refresh would get: step 5 moves the clock past an access token's life.
   */
  const signIn = async () => {
    for (const [role, id] of Object.entries(staffId)) {
      token[role as StaffRole] = await accessTokenFor(tokens, id);
    }

    const { accessToken } = await tokens.issueTokenPair(
      customer.id,
      SubjectType.CUSTOMER,
    );

    customer.headers = { Authorization: `Bearer ${accessToken}` };
  };

  let food: { id: string; slug: string; name: string; priceKobo: number };
  let drink: { id: string; slug: string; name: string; priceKobo: number };
  let drinkStockId: string;

  /** What steps 1 to 3 placed and step 6 replays. */
  let first: {
    reference: string;
    number: string;
    id: string;
    body: ReturnType<typeof chargeSuccessBody>;
  };

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    dispatcher = app.get(WebhookDispatcherService, { strict: false });
    paystack = fakePaystack(app);

    await seedData(prisma);
    fakeDateOnly(nextNoonInJos());

    tokens = app.get(CncTokenService, { strict: false });

    for (const role of [
      StaffRole.MANAGER,
      StaffRole.CASHIER,
      StaffRole.KITCHEN,
    ]) {
      staffId[role] = (await createStaffAccount(prisma, role)).id;
    }

    const row = await prisma.customer.create({
      data: {
        memberNo: await drawNumber(prisma, 'customer'),
        name: 'Ada Okafor',
        email: `ada-${randomUUID()}@cnc.test`,
        emailVerifiedAt: new Date(),
      },
    });

    customer = { id: row.id, email: row.email!, headers: {} };
    await signIn();

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
  const auth = (role: StaffRole) => ({
    Authorization: `Bearer ${token[role]!}`,
  });
  const vat = (kobo: number) => Math.round((kobo * 750) / 10000);

  const address = {
    zone: 'JOS',
    street: '12 Rayfield Road',
    area: 'Rayfield',
    town: 'Jos',
    landmark: 'Opposite the filling station',
  };
  /** Two dishes and a drink, as the website's cart sends them. */
  const cartLines = () => [
    { dishId: food.slug, qty: 2 },
    { dishId: drink.slug, qty: 1 },
  ];

  /** The cart for delivery within Jos, as the signed-in customer. */
  const checkout = async () =>
    (
      await request(server())
        .post('/api/v1/checkouts')
        .set('Idempotency-Key', randomUUID())
        .set(customer.headers)
        .send({
          lines: cartLines(),
          fulfilment: 'DELIVERY',
          address,
          timing: 'ASAP',
          name: 'Ada Okafor',
          phone: '0803 123 4567',
          email: customer.email,
          note: 'Ring twice',
        })
        .expect(201)
    ).body as { reference: string; authorizationUrl: string; sums: Sums };

  const pay = async (reference: string, totalKobo: number) => {
    const body = chargeSuccessBody(reference, totalKobo);

    await postSignedWebhook(app, body, PAYSTACK_KEY).expect(200);
    await dispatcher.settled();

    return body;
  };

  const onlineOf = (reference: string) =>
    prisma.onlineOrder.findUniqueOrThrow({
      where: { paystackReference: reference },
      include: { order: { select: { number: true } } },
    });

  const detail = async (id: string) =>
    (
      await request(server())
        .get(`/api/v1/staff/online-orders/${id}`)
        .set(auth(StaffRole.MANAGER))
        .expect(200)
    ).body as Detail;

  const command = async (
    id: string,
    name: string,
    role: StaffRole,
    body: Record<string, unknown>,
    key?: string,
  ) => {
    const call = request(server())
      .post(`/api/v1/staff/online-orders/${id}/${name}`)
      .set(auth(role));

    return (key ? call.set('Idempotency-Key', key) : call)
      .send({ version: (await detail(id)).version, ...body })
      .expect(200);
  };

  const bell = async (role: StaffRole) =>
    (
      (
        await request(server())
          .get('/api/v1/staff/notifications?pageSize=100')
          .set(auth(role))
          .expect(200)
      ).body as {
        data: { id: string; title: string; detail: string; ref?: string }[];
      }
    ).data;

  const tracker = async (number: string) =>
    (
      await request(server())
        .get(`/api/v1/me/orders/${number}`)
        .set(customer.headers)
        .expect(200)
    ).body as { status: OnlineFulfilmentStatus; sums: Sums };

  /** The last value a sequence handed out (null before its first draw). */
  const lastDrawn = async (sequence: string) => {
    const [row] = await prisma.$queryRawUnsafe<
      { last_value: bigint; is_called: boolean }[]
    >(`SELECT last_value, is_called FROM "${sequence}"`);

    return row.is_called ? Number(row.last_value) : null;
  };

  it('step 1: food and a drink for delivery within Jos cost subtotal + 7.5% VAT + ₦5,000, nothing added for Paystack (Q33)', async () => {
    const subtotal = food.priceKobo * 2 + drink.priceKobo;
    const expected: Sums = {
      subtotalKobo: subtotal,
      vatKobo: vat(subtotal),
      deliveryKobo: 500000,
      totalKobo: subtotal + vat(subtotal) + 500000,
    };

    const quote = (
      await request(server())
        .post('/api/v1/ordering/quote')
        .send({ lines: cartLines(), fulfilment: 'DELIVERY', zone: 'JOS' })
        .expect(200)
    ).body as { sums: Sums };

    expect(quote.sums).toEqual(expected);

    const created = await checkout();

    expect(created.sums).toEqual(expected);
    // Kobo reach Paystack as they are: never multiplied.
    expect(
      paystack.initialized.find((one) => one.reference === created.reference)
        ?.amountKobo,
    ).toBe(expected.totalKobo);

    const body = await pay(created.reference, expected.totalKobo);
    const confirmation = (
      await request(server())
        .get(`/api/v1/checkouts/${created.reference}`)
        .expect(200)
    ).body as { status: CheckoutStatus; number: string; card: string };

    expect(confirmation).toMatchObject({
      status: CheckoutStatus.PAID,
      card: 'Visa ending 4081',
    });
    expect(confirmation.number).toMatch(/^CNCR-\d{6}$/);
    // The receipt, always (Q31).
    expect(sentMail(app).lastTo(customer.email)?.subject).toBe(
      `Your CNC order is in: ${confirmation.number}`,
    );

    const online = await onlineOf(created.reference);

    first = {
      reference: created.reference,
      number: confirmation.number,
      id: online.id,
      body,
    };
  });

  it('step 2: it is in Online Orders and in POS history tagged Online; its docket lists the food only, and the Kitchen bell shows it', async () => {
    const active = (
      await request(server())
        .get('/api/v1/staff/online-orders?tab=ACTIVE')
        .set(auth(StaffRole.CASHIER))
        .expect(200)
    ).body as { data: { id: string; orderNumber: string }[] };

    expect(active.data).toContainEqual(
      expect.objectContaining({ id: first.id, orderNumber: first.number }),
    );

    const history = (
      await request(server())
        .get(
          `/api/v1/staff/orders?department=RESTAURANT&state=SETTLED&q=${first.number}`,
        )
        .set(auth(StaffRole.CASHIER))
        .expect(200)
    ).body as { data: { number: string; channel: string }[] };

    expect(history.data).toEqual([
      expect.objectContaining({ number: first.number, channel: 'WEB' }),
    ]);

    const ref = `KOT-${first.number}`;
    const docket = (
      await request(server())
        .get(`/api/v1/staff/dockets/${ref}`)
        .set(auth(StaffRole.KITCHEN))
        .expect(200)
    ).body as {
      channel: string;
      fulfilment: string;
      items: { menuItemId: string; qty: number }[];
    };

    expect(docket).toMatchObject({ channel: 'WEB', fulfilment: 'DELIVERY' });
    expect(docket.items).toEqual([
      expect.objectContaining({ menuItemId: food.id, qty: 2 }),
    ]);

    expect(await bell(StaffRole.KITCHEN)).toContainEqual(
      expect.objectContaining({
        title: 'New Web Docket',
        detail: `${ref} · As soon as possible`,
        ref,
      }),
    );
    expect(await bell(StaffRole.CASHIER)).toContainEqual(
      expect.objectContaining({
        id: `online:${first.id}`,
        title: 'Online Order · Paid',
      }),
    );
  });

  it('step 3: the Cashier moves it Preparing → Out for Delivery → Completed, and the customer’s tracker follows', async () => {
    expect((await tracker(first.number)).status).toBe(
      OnlineFulfilmentStatus.RECEIVED,
    );

    for (const status of [
      OnlineFulfilmentStatus.PREPARING,
      OnlineFulfilmentStatus.ON_THE_WAY,
      OnlineFulfilmentStatus.DELIVERED,
    ]) {
      await command(first.id, 'status', StaffRole.CASHIER, { status });
      expect((await tracker(first.number)).status).toBe(status);
    }

    expect(sentMail(app).lastTo(customer.email)?.subject).toBe(
      `Your CNC order ${first.number} is on its way`,
    );
    expect(
      (await bell(StaffRole.CASHIER)).some(
        (item) => item.id === `online:${first.id}`,
      ),
    ).toBe(false);
  });

  it('step 4: a manager edits an order down, and the refund goes back to the card through Paystack (Q26)', async () => {
    const created = await checkout();

    await pay(created.reference, created.sums.totalKobo);

    const online = await onlineOf(created.reference);
    const barBefore = await prisma.stockBalance.findUnique({
      where: {
        stockItemId_location: {
          stockItemId: drinkStockId,
          location: StockLocation.BAR,
        },
      },
    });

    await command(online.id, 'edit', StaffRole.MANAGER, {
      lines: [{ menuItemId: food.id, qty: 2 }],
      reason: 'The drink ran out',
    });

    const owed = (await detail(online.id)).money.balanceKobo;
    const withoutDrink = food.priceKobo * 2;
    const smaller = withoutDrink + vat(withoutDrink) + 500000;

    expect(owed).toBe(smaller - created.sums.totalKobo);

    await command(
      online.id,
      'balance',
      StaffRole.MANAGER,
      { method: 'PAYSTACK', reason: 'The drink ran out' },
      randomUUID(),
    );

    expect(paystack.refunds).toContainEqual(
      expect.objectContaining({
        transactionReference: created.reference,
        amountKobo: -owed,
      }),
    );

    const after = await detail(online.id);

    expect(after.money.balanceKobo).toBe(0);
    expect(after.refunds).toEqual([
      expect.objectContaining({
        amountKobo: -owed,
        status: OnlineRefundStatus.SENT,
      }),
    ]);
    expect(sentMail(app).lastTo(customer.email)?.subject).toBe(
      `Refund for your CNC order ${online.order.number}`,
    );
    // The drink went back to the Bar.
    expect(
      await prisma.stockMovement.count({
        where: {
          ref: online.order.number,
          type: StockMovementType.WEB_SALE_RETURN,
        },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.stockBalance.findUniqueOrThrow({
          where: {
            stockItemId_location: {
              stockItemId: drinkStockId,
              location: StockLocation.BAR,
            },
          },
        })
      ).qty,
    ).toBe((barBefore?.qty ?? 0) + 1);
    // The tracker shows the order as it now stands.
    expect((await tracker(online.order.number)).sums.totalKobo).toBe(smaller);
  });

  it('step 5: an abandoned checkout expires and burns no order number', async () => {
    const created = await checkout();
    const orders = await lastDrawn('order_restaurant_no_seq');
    const web = await lastDrawn('online_order_no_seq');

    // Past the checkout's 30 minutes, then the checkouts sweep asks Paystack.
    jest.setSystemTime(Date.now() + 31 * MINUTE);
    await signIn();

    await request(server())
      .post('/api/v1/internal/sweeps/checkouts')
      .set(SWEEP_TOKEN_HEADER, SWEEP_TOKEN)
      .set('Content-Length', '0')
      .expect(200);

    expect(
      (
        await prisma.checkout.findUniqueOrThrow({
          where: { reference: created.reference },
        })
      ).status,
    ).toBe(CheckoutStatus.EXPIRED);
    expect(await lastDrawn('order_restaurant_no_seq')).toBe(orders);
    expect(await lastDrawn('online_order_no_seq')).toBe(web);
    expect(
      (
        await request(server())
          .get(`/api/v1/checkouts/${created.reference}`)
          .expect(200)
      ).body,
    ).toMatchObject({ status: CheckoutStatus.EXPIRED, number: null });
  });

  it('step 6: a replayed webhook changes nothing, and a wrong amount leaves the checkout in Needs Attention', async () => {
    const mails = sentMail(app).sent.length;

    await postSignedWebhook(app, first.body, PAYSTACK_KEY).expect(200);
    await dispatcher.settled();

    expect(
      await prisma.order.count({
        where: { checkout: { reference: first.reference } },
      }),
    ).toBe(1);
    expect(
      await prisma.payment.count({ where: { providerRef: first.reference } }),
    ).toBe(1);
    expect((await tracker(first.number)).status).toBe(
      OnlineFulfilmentStatus.DELIVERED,
    );
    expect(sentMail(app).sent.length).toBe(mails);

    const created = await checkout();
    const orders = await lastDrawn('order_restaurant_no_seq');

    await postSignedWebhook(
      app,
      chargeSuccessBody(created.reference, created.sums.totalKobo - 100),
      PAYSTACK_KEY,
    ).expect(200);
    await dispatcher.settled();

    const held = await prisma.checkout.findUniqueOrThrow({
      where: { reference: created.reference },
    });

    expect(held).toMatchObject({
      status: CheckoutStatus.NEEDS_ATTENTION,
      orderId: null,
    });
    expect(await lastDrawn('order_restaurant_no_seq')).toBe(orders);
    expect(await bell(StaffRole.MANAGER)).toContainEqual(
      expect.objectContaining({
        id: `attention:${held.id}`,
        title: 'Checkout Needs Attention',
      }),
    );
    expect(sentMail(app).lastTo(INBOX)?.subject).toBe(
      `Online payment needs attention: ${created.reference}`,
    );
  });
});
