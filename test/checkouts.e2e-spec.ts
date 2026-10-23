/*
 * CNC's Paystack key and inbox for this suite, set before the app is built
 * so nothing depends on the developer's `.env` (`ConfigModule` never
 * overwrites a value already present; Jest gives each file its own
 * process.env). A test key that signs this suite's fake webhooks only:
 * the Paystack client is `FakePaystackClient`, which calls nobody.
 */
const PAYSTACK_KEY = 'sk_test_cnc_checkouts_e2e_not_a_real_key';
const INBOX = 'cnc-checkouts-inbox@cnc.test';

process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;
process.env.CNC_CONTACT_EMAIL = INBOX;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CheckoutStatus,
  Department,
  OutboundMessageStatus,
  SubjectType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { DELIVERY_LANDMARK_MESSAGE } from '../src/common/delivery-address';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { DELETE_WITH_UPCOMING_MESSAGE } from '../src/customers/customer-deletion.service';
import {
  CART_EMPTY_MESSAGE,
  CHECKOUT_NAME_MESSAGE,
  CHECKOUT_NOT_FOUND_MESSAGE,
  CHECKOUT_TIME_MESSAGE,
  DISH_UNAVAILABLE_MESSAGE,
  STREET_MESSAGE,
} from '../src/ordering/checkout-messages';
import {
  INVALID_SIGNATURE_MESSAGE,
  ONLINE_PAYMENT_UNAVAILABLE_MESSAGE,
  PAYMENT_PROVIDER_UNREACHABLE_MESSAGE,
  PAYMENT_START_FAILED_MESSAGE,
} from '../src/payments/payment-messages';
import {
  PaystackRefusedError,
  PaystackUnavailableError,
} from '../src/payments/paystack-client';
import { WebhookDispatcherService } from '../src/payments/webhook-dispatcher.service';
import { drawNumber } from '../src/prisma/sequences';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp, sentMail } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import { fakePaystack } from './fake-paystack-client';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { chargeSuccessBody, postSignedWebhook } from './paystack-webhooks';

interface CreatedBody {
  reference: string;
  accessCode: string;
  authorizationUrl: string;
  expiresAt: string;
  vatBps: number;
  lines: {
    dishId: string;
    name: string;
    option: string;
    qty: number;
    unitKobo: number;
  }[];
  sums: {
    subtotalKobo: number;
    vatKobo: number;
    deliveryKobo: number;
    totalKobo: number;
  };
  warnings: string[];
}

/**
 * The web checkout and Paystack's webhook (plan §7.4 steps 1 to 3, cards
 * C7-1 and C7-2), through HTTP with no real Paystack: the client is the
 * harness's `FakePaystackClient`, and every webhook is signed here with
 * the suite's test key, as Paystack signs one.
 *
 * On a database of its own with the real seeds and the clock faked from
 * the next noon in Jos, so the slots and "as soon as possible" are known,
 * and so its Settings, menu and Bar stock are its own.
 */
describe('checkouts and the Paystack webhook (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  let dispatcher: WebhookDispatcherService;
  let food: { slug: string; name: string; priceKobo: number };
  let drink: { slug: string; name: string; priceKobo: number };
  let choice: { slug: string; name: string; options: string[] };

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
    const foodRow = await prisma.menuItem.findFirstOrThrow({
      where: {
        ...online,
        department: Department.RESTAURANT,
        choiceOptions: { isEmpty: true },
        priceKobo: { gt: 0 },
      },
      orderBy: { slug: 'asc' },
    });
    const drinkRow = await prisma.menuItem.findFirstOrThrow({
      where: { ...online, department: Department.BAR, priceKobo: { gt: 0 } },
      orderBy: { slug: 'asc' },
    });
    const choiceRow = await prisma.menuItem.findFirstOrThrow({
      where: { ...online, NOT: { choiceOptions: { isEmpty: true } } },
      orderBy: { slug: 'asc' },
    });

    food = foodRow;
    drink = drinkRow;
    choice = {
      slug: choiceRow.slug,
      name: choiceRow.name,
      options: choiceRow.choiceOptions,
    };
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
      { dishId: drink.slug, qty: 1 },
    ],
    fulfilment: 'DELIVERY',
    address,
    timing: 'ASAP',
    name: 'Ada Okafor',
    phone: '0803 123 4567',
    email: 'Ada.Checkout@Example.com',
    note: 'Ring twice',
    ...over,
  });

  const checkout = (
    body: Record<string, unknown> = checkoutBody(),
    key: string = randomUUID(),
    headers: Record<string, string> = {},
  ) =>
    request(server())
      .post('/api/v1/checkouts')
      .set('Idempotency-Key', key)
      .set(headers)
      .send(body);

  /** Post a webhook body signed as Paystack signs it. */
  const webhook = (body: unknown, key = PAYSTACK_KEY) =>
    postSignedWebhook(app, body, key);

  const chargeSuccess = chargeSuccessBody;

  const created = async (body = checkoutBody()) =>
    (await checkout(body).expect(201)).body as CreatedBody;

  const row = (reference: string) =>
    prisma.checkout.findUniqueOrThrow({ where: { reference } });

  describe('POST /ordering/quote', () => {
    it('prices the cart from the menu: subtotal + 7.5% VAT + ₦5,000 within Jos (Q33)', async () => {
      const response = await request(server())
        .post('/api/v1/ordering/quote')
        .send({
          lines: [
            { dishId: food.slug, qty: 2 },
            { dishId: drink.slug, qty: 1 },
          ],
          fulfilment: 'DELIVERY',
          zone: 'JOS',
        })
        .expect(200);
      const body = response.body as Omit<CreatedBody, 'reference'>;
      const subtotal = food.priceKobo * 2 + drink.priceKobo;
      const vat = Math.round((subtotal * 750) / 10000);

      expect(response.headers['cache-control']).toBe('no-store');
      expect(body.sums).toEqual({
        subtotalKobo: subtotal,
        vatKobo: vat,
        deliveryKobo: 500000,
        totalKobo: subtotal + vat + 500000,
      });
      expect(body.lines).toEqual([
        {
          dishId: food.slug,
          name: food.name,
          option: '',
          qty: 2,
          unitKobo: food.priceKobo,
        },
        {
          dishId: drink.slug,
          name: drink.name,
          option: '',
          qty: 1,
          unitKobo: drink.priceKobo,
        },
      ]);
      // Q11: the Bar holds nothing yet, so the drink warns and never refuses.
      expect(body.warnings).toEqual([
        `We may be short of ${drink.name} at the bar. If it runs out, we will call you before your order is ready.`,
      ]);
    });

    it('charges no fee for pickup and ₦10,000 elsewhere in Plateau', async () => {
      const quote = async (fulfilment: string, zone?: string) =>
        (
          (
            await request(server())
              .post('/api/v1/ordering/quote')
              .send({
                lines: [{ dishId: food.slug, qty: 1 }],
                fulfilment,
                zone,
              })
              .expect(200)
          ).body as CreatedBody
        ).sums.deliveryKobo;

      expect(await quote('PICKUP')).toBe(0);
      expect(await quote('DELIVERY', 'PLATEAU')).toBe(1000000);
    });

    it('refuses an empty cart, a dish not online and a missing choice', async () => {
      const quote = (lines: unknown) =>
        request(server())
          .post('/api/v1/ordering/quote')
          .send({ lines, fulfilment: 'PICKUP' })
          .expect(400);

      expect(messageOf(await quote([]))).toEqual([CART_EMPTY_MESSAGE]);
      expect(messageOf(await quote([{ dishId: 'no-such-dish', qty: 1 }]))).toBe(
        DISH_UNAVAILABLE_MESSAGE,
      );
      expect(messageOf(await quote([{ dishId: choice.slug, qty: 1 }]))).toBe(
        `Choose one of the options for ${choice.name}.`,
      );
    });
  });

  describe('POST /checkouts', () => {
    it('stores a PENDING checkout, initializes Paystack for its exact total, and draws no order number', async () => {
      const ordersBefore = await prisma.order.count();
      const body = await created();
      const stored = await row(body.reference);
      const sent = fakePaystack(app).initialized.find(
        (one) => one.reference === body.reference,
      );

      expect(body.reference).toMatch(
        /^cnc-order-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(body.authorizationUrl).toBe(
        `https://checkout.paystack.test/${body.reference}`,
      );
      expect(body.accessCode).toBe(`access-${body.reference}`);
      // Kobo, never multiplied by 100.
      expect(sent).toMatchObject({
        amountKobo: body.sums.totalKobo,
        email: 'ada.checkout@example.com',
      });
      expect(stored).toMatchObject({
        status: CheckoutStatus.PENDING,
        source: 'WEB',
        customerId: null,
        orderId: null,
        totalKobo: body.sums.totalKobo,
        deliveryKobo: 500000,
        vatBps: 750,
        contactPhone: '08031234567',
        contactEmail: 'ada.checkout@example.com',
        zone: 'JOS',
        addressLandmark: 'Opposite the filling station',
        timing: 'ASAP',
        timingText: 'As soon as possible, about 90 minutes',
        scheduledFor: null,
        accessCode: body.accessCode,
      });
      expect(
        stored.expiresAt.getTime() - stored.createdAt.getTime(),
      ).toBeGreaterThanOrEqual(29 * 60 * 1000);
      expect(await prisma.order.count()).toBe(ordersBefore);
    });

    it('answers a retry with the same key with the same checkout and payment page, initializing once', async () => {
      const key = randomUUID();
      const body = checkoutBody({ name: 'Retry Guest' });
      const first = (await checkout(body, key).expect(201)).body as CreatedBody;
      const second = (await checkout(body, key).expect(201))
        .body as CreatedBody;

      expect(second).toEqual(first);
      expect(
        fakePaystack(app).initialized.filter(
          (one) => one.reference === first.reference,
        ),
      ).toHaveLength(1);
      expect(
        await prisma.checkout.count({ where: { contactName: 'Retry Guest' } }),
      ).toBe(1);

      expect(
        messageOf(
          await checkout(checkoutBody({ name: 'Other' }), key).expect(409),
        ),
      ).toBe('This Idempotency-Key was already used for a different request.');
    });

    it('needs an Idempotency-Key', async () => {
      await request(server())
        .post('/api/v1/checkouts')
        .send(checkoutBody())
        .expect(400);
    });

    it('answers the website form’s sentences', async () => {
      const refusal = async (over: Record<string, unknown>) =>
        messageOf(await checkout(checkoutBody(over)).expect(400));

      expect(await refusal({ name: '  ' })).toEqual([CHECKOUT_NAME_MESSAGE]);
      expect(await refusal({ address: { ...address, street: '' } })).toEqual([
        STREET_MESSAGE,
      ]);
      expect(await refusal({ address: { ...address, landmark: '' } })).toEqual([
        DELIVERY_LANDMARK_MESSAGE,
      ]);
      expect(await refusal({ email: '' })).toEqual([
        'Add your email for the receipt.',
      ]);
      expect(await refusal({ email: 'not-an-email' })).toEqual([
        'Check the email address.',
      ]);
      expect(await refusal({ phone: '123' })).toEqual([
        'Enter a Nigerian phone number, for example 0803 123 4567.',
      ]);
    });

    it('takes an offered slot and refuses one inside the lead (the slots’ own rules)', async () => {
      const today = formatIsoDate(watToday(new Date()));
      const tomorrow = formatIsoDate(addDays(watToday(new Date()), 1));
      const slots = (
        await request(server())
          .get('/api/v1/ordering/slots?fulfilment=DELIVERY&zone=JOS')
          .expect(200)
      ).body as { today: string[] };

      // Noon in Jos: 12:30 is inside the 90-minute lead.
      expect(
        messageOf(
          await checkout(
            checkoutBody({ timing: 'SCHEDULED', date: today, time: '12:30' }),
          ).expect(400),
        ),
      ).toBe(CHECKOUT_TIME_MESSAGE);

      const body = await created(
        checkoutBody({
          timing: 'SCHEDULED',
          date: today,
          time: slots.today[0],
        }),
      );
      const stored = await row(body.reference);

      expect(stored.timing).toBe('SCHEDULED');
      expect(stored.scheduledFor).not.toBeNull();

      await checkout(
        checkoutBody({ timing: 'SCHEDULED', date: tomorrow, time: '08:00' }),
      ).expect(201);
    });

    it('is the app’s and the customer’s with a customer token', async () => {
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
      const body = (
        await checkout(checkoutBody(), randomUUID(), {
          Authorization: `Bearer ${accessToken}`,
        }).expect(201)
      ).body as CreatedBody;

      expect(await row(body.reference)).toMatchObject({
        source: 'APP',
        customerId: customer.id,
      });

      // A checkout waiting for its payment keeps the account (Q36).
      expect(
        messageOf(
          await request(server())
            .delete('/api/v1/me')
            .set('Authorization', `Bearer ${accessToken}`)
            .expect(409),
        ),
      ).toBe(DELETE_WITH_UPCOMING_MESSAGE);
    });

    it('waits when Paystack cannot be reached, and the same key then starts the payment', async () => {
      const key = randomUUID();
      const body = checkoutBody({ name: 'Unreachable Guest' });

      fakePaystack(app).failNextInitializeWith = new PaystackUnavailableError();
      expect(messageOf(await checkout(body, key).expect(503))).toBe(
        PAYMENT_PROVIDER_UNREACHABLE_MESSAGE,
      );

      const waiting = await prisma.checkout.findFirstOrThrow({
        where: { contactName: 'Unreachable Guest' },
      });

      expect(waiting).toMatchObject({
        status: CheckoutStatus.PENDING,
        accessCode: null,
      });

      const retried = (await checkout(body, key).expect(201))
        .body as CreatedBody;

      expect(retried.reference).toBe(waiting.reference);
      expect(retried.authorizationUrl).toContain(waiting.reference);
    });

    it('closes the checkout FAILED when Paystack refuses to start it', async () => {
      fakePaystack(app).failNextInitializeWith = new PaystackRefusedError(
        400,
        'Invalid email',
      );

      expect(
        messageOf(
          await checkout(checkoutBody({ name: 'Refused Guest' })).expect(502),
        ),
      ).toBe(PAYMENT_START_FAILED_MESSAGE);
      expect(
        (
          await prisma.checkout.findFirstOrThrow({
            where: { contactName: 'Refused Guest' },
          })
        ).status,
      ).toBe(CheckoutStatus.FAILED);
    });

    it('refuses with 503 while the Paystack key is the placeholder, storing nothing', async () => {
      const before = await prisma.checkout.count();

      process.env.CNC_PAYSTACK_SECRET_KEY = 'PLACEHOLDER_NOT_SET';
      try {
        expect(messageOf(await checkout().expect(503))).toBe(
          ONLINE_PAYMENT_UNAVAILABLE_MESSAGE,
        );
        expect(
          messageOf(
            await webhook(chargeSuccess('x', 1), 'PLACEHOLDER_NOT_SET').expect(
              503,
            ),
          ),
        ).toBe(ONLINE_PAYMENT_UNAVAILABLE_MESSAGE);
      } finally {
        process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;
      }

      expect(await prisma.checkout.count()).toBe(before);
    });
  });

  describe('GET /checkouts/:reference', () => {
    it('answers the confirmation page and nothing private', async () => {
      const body = await created();
      const response = await request(server())
        .get(`/api/v1/checkouts/${body.reference}`)
        .expect(200);

      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.body as object).sort()).toEqual(
        [
          'address',
          'card',
          'fulfilment',
          'lines',
          'name',
          'number',
          'reference',
          'scheduledFor',
          'status',
          'sums',
          'timing',
          'zone',
        ].sort(),
      );
      expect(response.body).toMatchObject({
        status: 'PENDING',
        number: null,
        name: 'Ada Okafor',
        fulfilment: 'DELIVERY',
        zone: 'JOS',
        address:
          '12 Rayfield Road, Rayfield, Jos, Landmark: Opposite the filling station',
        timing: 'As soon as possible, about 90 minutes',
        card: null,
        sums: body.sums,
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /0803|example\.com|Ring twice/,
      );
    });

    it('writes pickup at CNC’s address', async () => {
      const body = await created(
        checkoutBody({ fulfilment: 'PICKUP', address: undefined }),
      );
      const read = (
        await request(server())
          .get(`/api/v1/checkouts/${body.reference}`)
          .expect(200)
      ).body as {
        address: string;
        zone: unknown;
        sums: { deliveryKobo: number };
      };

      expect(read.address).toMatch(/^Pickup at CNC, .+, Nigeria$/);
      expect(read.zone).toBeNull();
      expect(read.sums.deliveryKobo).toBe(0);
    });

    it('is 404 for a reference no checkout holds', async () => {
      expect(
        messageOf(
          await request(server())
            .get(`/api/v1/checkouts/cnc-order-${randomUUID()}`)
            .expect(404),
        ),
      ).toBe(CHECKOUT_NOT_FOUND_MESSAGE);
    });
  });

  describe('POST /payments/webhook', () => {
    it('refuses an unsigned or wrongly signed delivery and records nothing', async () => {
      const before = await prisma.paymentEvent.count();
      const raw = JSON.stringify(chargeSuccess('cnc-order-x', 100));

      expect(
        messageOf(
          await request(server())
            .post('/api/v1/payments/webhook')
            .set('Content-Type', 'application/json')
            .send(raw)
            .expect(401),
        ),
      ).toBe(INVALID_SIGNATURE_MESSAGE);
      await webhook(
        chargeSuccess('cnc-order-x', 100),
        'sk_test_someone_else',
      ).expect(401);
      expect(await prisma.paymentEvent.count()).toBe(before);
    });

    it('pays the checkout on a signed charge.success that verify confirms; a replay changes nothing', async () => {
      const body = await created();
      const event = chargeSuccess(body.reference, body.sums.totalKobo);

      expect((await webhook(event).expect(200)).body).toEqual({
        received: true,
      });
      await dispatcher.settled();

      const paid = await row(body.reference);

      expect(paid).toMatchObject({
        status: CheckoutStatus.PAID,
        cardBrand: 'Visa',
        cardLast4: '4081',
      });
      expect(paid.paidAt).not.toBeNull();
      expect(
        fakePaystack(app).verified.filter((one) => one === body.reference),
      ).toHaveLength(1);

      const events = await prisma.paymentEvent.findMany({
        where: { reference: body.reference },
      });

      expect(events).toHaveLength(1);
      expect(events[0].processedAt).not.toBeNull();

      const read = (
        await request(server())
          .get(`/api/v1/checkouts/${body.reference}`)
          .expect(200)
      ).body as { status: string; card: string };

      expect(read).toMatchObject({ status: 'PAID', card: 'Visa ending 4081' });

      // The same bytes again: acknowledged, one ledger row, no second verify.
      await webhook(event).expect(200);
      await dispatcher.settled();
      expect(
        await prisma.paymentEvent.count({
          where: { reference: body.reference },
        }),
      ).toBe(1);
      expect(
        fakePaystack(app).verified.filter((one) => one === body.reference),
      ).toHaveLength(1);
      expect((await row(body.reference)).updatedAt).toEqual(paid.updatedAt);

      // A different delivery for a paid checkout changes nothing either.
      await webhook(chargeSuccess(body.reference, body.sums.totalKobo)).expect(
        200,
      );
      await dispatcher.settled();
      expect((await row(body.reference)).updatedAt).toEqual(paid.updatedAt);
    });

    it('holds a checkout NEEDS_ATTENTION on a wrong amount, creates nothing and emails CNC', async () => {
      const ordersBefore = await prisma.order.count();
      const body = await created(checkoutBody({ name: 'Wrong Amount' }));

      await webhook(
        chargeSuccess(body.reference, body.sums.totalKobo - 100),
      ).expect(200);
      await dispatcher.settled();

      const held = await row(body.reference);

      expect(held.status).toBe(CheckoutStatus.NEEDS_ATTENTION);
      expect(held.attentionReason).toMatch(/The event named/);
      expect(held.paidAt).toBeNull();
      expect(held.orderId).toBeNull();
      expect(await prisma.order.count()).toBe(ordersBefore);

      const mail = await prisma.outboundMessage.findUniqueOrThrow({
        where: { dedupeKey: `checkout:${held.id}:attention` },
      });

      expect(mail).toMatchObject({
        to: INBOX,
        status: OutboundMessageStatus.SENT,
      });
      expect(
        sentMail(app).sent.some(
          (one) => one.to === INBOX && one.subject.includes(body.reference),
        ),
      ).toBe(true);

      // A later correct delivery does not undo the hold.
      await webhook(chargeSuccess(body.reference, body.sums.totalKobo)).expect(
        200,
      );
      await dispatcher.settled();
      expect((await row(body.reference)).status).toBe(
        CheckoutStatus.NEEDS_ATTENTION,
      );
    });

    it('holds a checkout when verify disagrees with a correct-looking event', async () => {
      const body = await created();

      fakePaystack(app).verifyAnswers.set(body.reference, {
        amountKobo: body.sums.totalKobo * 2,
      });
      await webhook(chargeSuccess(body.reference, body.sums.totalKobo)).expect(
        200,
      );
      await dispatcher.settled();
      expect((await row(body.reference)).status).toBe(
        CheckoutStatus.NEEDS_ATTENTION,
      );

      const other = await created();

      fakePaystack(app).verifyAnswers.set(other.reference, { currency: 'USD' });
      await webhook(
        chargeSuccess(other.reference, other.sums.totalKobo),
      ).expect(200);
      await dispatcher.settled();
      expect((await row(other.reference)).status).toBe(
        CheckoutStatus.NEEDS_ATTENTION,
      );
    });

    it('leaves the delivery unprocessed when verify cannot be reached', async () => {
      const body = await created();

      fakePaystack(app).failNextVerifyWith = new PaystackUnavailableError();
      await webhook(chargeSuccess(body.reference, body.sums.totalKobo)).expect(
        200,
      );
      await dispatcher.settled();

      expect((await row(body.reference)).status).toBe(CheckoutStatus.PENDING);
      expect(
        (
          await prisma.paymentEvent.findFirstOrThrow({
            where: { reference: body.reference },
          })
        ).processedAt,
      ).toBeNull();
    });

    it('acknowledges an unknown reference and an event CNC does not act on', async () => {
      await webhook(chargeSuccess(`cnc-order-${randomUUID()}`, 100)).expect(
        200,
      );
      await webhook({
        event: 'transfer.success',
        data: { reference: 'tr-1' },
      }).expect(200);
      await dispatcher.settled();

      expect(
        await prisma.paymentEvent.count({
          where: { reference: 'tr-1', processedAt: { not: null } },
        }),
      ).toBe(1);
    });
  });
});
