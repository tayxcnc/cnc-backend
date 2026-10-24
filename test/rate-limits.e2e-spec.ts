const PAYSTACK_KEY = 'sk_test_cnc_rate_limits_e2e_not_a_real_key';

process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  OrderStatus,
  StaffRole,
  SubjectType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import {
  ACCOUNT_DELETE_LIMIT,
  AUTH_ATTEMPT_LIMIT,
  BOOKING_CHANGE_LIMIT,
  CUSTOMER_PHOTO_LIMIT,
  CUSTOMER_SIGN_OUT_LIMIT,
  NOTIFICATIONS_READ_LIMIT,
  REFRESH_ATTEMPT_LIMIT,
  SIGN_IN_ADDRESS_LIMIT,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from '../src/auth/auth-throttle';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { RateLimitStore } from '../src/common/throttler/rate-limit-store';
import { watToday } from '../src/common/wat';
import { CustomerService } from '../src/customers/customer.service';
import {
  CHECKOUT_ADDRESS_LIMIT,
  CHECKOUT_READ_ADDRESS_LIMIT,
  CHECKOUT_READ_WINDOW_MS,
} from '../src/ordering/checkouts.controller';
import { QUOTE_ADDRESS_LIMIT } from '../src/ordering/ordering.controller';
import {
  WEBHOOK_BAD_SIGNATURE_LIMIT,
  WEBHOOK_BAD_SIGNATURE_WINDOW_MS,
} from '../src/payments/payments.controller';
import { WebhookDispatcherService } from '../src/payments/webhook-dispatcher.service';
import { signPaystackBody } from '../src/payments/webhook-signature';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp } from './create-test-app';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { createStaffAccount } from './staff-fixtures';

const FIFTEEN_MINUTES_S = 15 * 60;

/**
 * The rate limits on every public and customer write (card C8-3): stored,
 * so instances share them; a 429 with the plain sentence and a standard
 * `Retry-After`; a number for each route that had none; and the webhook,
 * which counts only bad signatures and never refuses a signed delivery.
 *
 * On a database of its own with the real seeds, because the checks below
 * read and write whole tables (`RateLimitCount`, `PaymentEvent`). Each app
 * `createTestApp` builds has its own count namespace; the cross-instance
 * test builds two apps on one namespace, as two Cloud Run instances of one
 * deployment.
 */
describe('Rate limits (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  let dispatcher: WebhookDispatcherService;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });
    dispatcher = app.get(WebhookDispatcherService, { strict: false });
    await seedData(prisma);
  }, 180_000);

  afterAll(async () => {
    await dispatcher?.settled();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();

  /** A fresh caller, as Cloud Run's front end forwards it. */
  const address = () => `10.${[...randomBytes(3)].join('.')}, 10.255.255.1`;

  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  /** A refusal by a rate limit: 429, the sentence, a standard Retry-After. */
  function expectRefused(response: request.Response, windowSeconds: number) {
    expect(response.status).toBe(429);
    expect(messageOf(response)).toBe(TOO_MANY_ATTEMPTS_MESSAGE);

    const retryAfter = Number(response.headers['retry-after']);

    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
  }

  /** `count` requests, each answered `status`; then the next. */
  async function exhaust(
    send: () => request.Test,
    count: number,
    status: number,
  ): Promise<request.Response> {
    for (let i = 1; i <= count; i += 1) {
      const response = await send();

      expect({ attempt: i, status: response.status }).toEqual({
        attempt: i,
        status,
      });
    }

    return send();
  }

  /** A verified customer with a session, made directly. */
  async function customer() {
    const customers = app.get(CustomerService, { strict: false });
    const email = `limits-${randomUUID()}@example.com`;
    const { id } = await prisma.$transaction((tx) =>
      customers.findOrCreateVerified(tx, email),
    );
    const pair = await tokens.issueTokenPair(id, SubjectType.CUSTOMER);

    return { id, email, auth: { Authorization: `Bearer ${pair.accessToken}` } };
  }

  describe('stored counts', () => {
    it('are one number for every instance of a deployment, and survive a restart', async () => {
      const namespace = `instances-${randomUUID()}`;
      const first = await createTestApp({ rateLimitNamespace: namespace });
      const second = await createTestApp({ rateLimitNamespace: namespace });
      const otherDeployment = await createTestApp();
      const open = new Set([first, second, otherDeployment]);

      try {
        const account = await createStaffAccount(prisma, StaffRole.CASHIER);
        const from = address();
        const signIn = (on: INestApplication<App>) =>
          request(on.getHttpServer())
            .post('/api/v1/auth/staff/sign-in')
            .set('X-Forwarded-For', from)
            .send({ email: account.email, password: 'wrong-password' });

        // Half on each instance: in memory each would have allowed ten.
        for (let attempt = 1; attempt <= AUTH_ATTEMPT_LIMIT; attempt += 1) {
          await signIn(attempt % 2 ? first : second).expect(401);
        }

        expectRefused(await signIn(first), FIFTEEN_MINUTES_S);
        expectRefused(await signIn(second), FIFTEEN_MINUTES_S);

        // A restarted instance reads the same rows.
        await first.close();
        open.delete(first);

        const restarted = await createTestApp({
          rateLimitNamespace: namespace,
        });

        open.add(restarted);
        expectRefused(await signIn(restarted), FIFTEEN_MINUTES_S);

        // Another deployment's counts are its own.
        await signIn(otherDeployment).expect(401);
      } finally {
        for (const one of open) await one.close();
      }
    }, 120_000);

    it('count requests arriving together exactly once each', async () => {
      const store = app.get(RateLimitStore, { strict: false });
      const key = `together:${randomUUID()}`;

      const hits = await Promise.all(
        Array.from({ length: 25 }, () => store.hit(key, 10, 60_000)),
      );

      expect(hits.filter((hit) => !hit.blocked)).toHaveLength(10);
      expect(hits.filter((hit) => hit.blocked)).toHaveLength(15);
      expect(
        hits
          .filter((hit) => !hit.blocked)
          .map((hit) => hit.hits)
          .sort((a, b) => a - b),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('start a fresh window once the block has ended', async () => {
      const store = app.get(RateLimitStore, { strict: false });
      const key = `window:${randomUUID()}`;

      expect((await store.hit(key, 2, 1_000)).blocked).toBe(false);
      expect((await store.hit(key, 2, 1_000)).blocked).toBe(false);

      const over = await store.hit(key, 2, 1_000);

      expect(over).toMatchObject({ blocked: true, retryAfterSeconds: 1 });
      // While blocked, a request is refused and not counted.
      expect(await store.hit(key, 2, 1_000)).toMatchObject({
        blocked: true,
        hits: 3,
      });

      await new Promise((resolve) => setTimeout(resolve, 1_200));

      expect(await store.hit(key, 2, 1_000)).toMatchObject({
        blocked: false,
        hits: 1,
      });
    });

    it('refuse a key this instance saw blocked from memory, with no database write, until the block ends', async () => {
      const store = app.get(RateLimitStore, { strict: false });
      const key = `memory:${randomUUID()}`;
      const digest = createHash('sha256').update(key).digest('hex');
      const row = async () =>
        (await prisma.rateLimitCount.findFirst({
          where: { key: { endsWith: `:${digest}` } },
        })) ?? undefined;

      await store.hit(key, 1, 1_500);
      expect(await store.hit(key, 1, 1_500)).toMatchObject({
        blocked: true,
        hits: 2,
        retryAfterSeconds: 2,
      });

      // The stored row is deleted: a refusal that still went to Postgres
      // would write it again as a fresh window, and be let through.
      await prisma.rateLimitCount.delete({
        where: { key: (await row())!.key },
      });

      for (let i = 0; i < 5; i += 1) {
        expect(await store.hit(key, 1, 1_500)).toMatchObject({
          blocked: true,
          hits: 2,
        });
      }
      expect(await row()).toBeUndefined();

      // Once the block has ended, the next request is counted again.
      await new Promise((resolve) => setTimeout(resolve, 1_700));

      expect(await store.hit(key, 1, 1_500)).toMatchObject({
        blocked: false,
        hits: 1,
      });
      expect((await row())?.hits).toBe(1);
    });
  });

  describe('staff sign-in and refresh', () => {
    it(`sign-in: ${SIGN_IN_ADDRESS_LIMIT} per address over every email, then 429 with Retry-After`, async () => {
      const from = address();
      const refused = await exhaust(
        () =>
          request(server())
            .post('/api/v1/auth/staff/sign-in')
            .set('X-Forwarded-For', from)
            .send({
              email: `spray-${randomUUID()}@example.com`,
              password: 'Summer2026!',
            }),
        SIGN_IN_ADDRESS_LIMIT,
        401,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
    }, 120_000);

    it(`refresh: ${REFRESH_ATTEMPT_LIMIT} per address, then 429 with Retry-After`, async () => {
      const from = address();
      const refused = await exhaust(
        () =>
          request(server())
            .post('/api/v1/auth/staff/refresh')
            .set('X-Forwarded-For', from)
            .set('Content-Type', 'application/json')
            .send({}),
        // No refresh cookie: 400, after it is counted.
        REFRESH_ATTEMPT_LIMIT,
        400,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
    }, 180_000);
  });

  describe('customer sign-in', () => {
    it(`POST /auth/code: ${SIGN_IN_ADDRESS_LIMIT} per address, then 429 with Retry-After`, async () => {
      const from = address();
      // A phone number is refused (400) after it is counted.
      const refused = await exhaust(
        () =>
          request(server())
            .post('/api/v1/auth/code')
            .set('X-Forwarded-For', from)
            .send({ email: '08031234567' }),
        SIGN_IN_ADDRESS_LIMIT,
        400,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
    }, 120_000);

    it(`POST /auth/verify: ${AUTH_ATTEMPT_LIMIT} per email at one address, then 429`, async () => {
      const from = address();
      const email = `verify-${randomUUID()}@example.com`;
      const refused = await exhaust(
        () =>
          request(server())
            .post('/api/v1/auth/verify')
            .set('X-Forwarded-For', from)
            .send({ email, code: '000000' }),
        AUTH_ATTEMPT_LIMIT,
        400,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
    });

    it(`POST /auth/refresh: ${REFRESH_ATTEMPT_LIMIT} per address, then 429`, async () => {
      const from = address();
      const refused = await exhaust(
        () =>
          request(server())
            .post('/api/v1/auth/refresh')
            .set('X-Forwarded-For', from)
            .set('Content-Type', 'application/json')
            .send({}),
        // No refresh cookie: 400, after it is counted.
        REFRESH_ATTEMPT_LIMIT,
        400,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
    }, 180_000);

    it(`POST /auth/sign-out: ${CUSTOMER_SIGN_OUT_LIMIT} per customer from any address, counted only once the token is good`, async () => {
      const me = await customer();
      const signOut = (headers: Record<string, string>) =>
        request(server())
          .post('/api/v1/auth/sign-out')
          .set('X-Forwarded-For', address())
          .set(headers);

      // No token: refused before it is counted.
      for (let i = 0; i < CUSTOMER_SIGN_OUT_LIMIT + 5; i += 1) {
        await signOut({}).expect(401);
      }

      expectRefused(
        await exhaust(() => signOut(me.auth), CUSTOMER_SIGN_OUT_LIMIT, 204),
        FIFTEEN_MINUTES_S,
      );
      // Another customer has a count of their own.
      await signOut((await customer()).auth).expect(204);
    });
  });

  describe('the email change', () => {
    it(`POST /me/email/code: ${SIGN_IN_ADDRESS_LIMIT} per address, then 429 with Retry-After`, async () => {
      const me = await customer();
      const from = address();
      // Not an email: refused (400) after it is counted.
      const refused = await exhaust(
        () =>
          request(server())
            .post('/api/v1/me/email/code')
            .set(me.auth)
            .set('X-Forwarded-For', from)
            .send({ email: 'not-an-email' }),
        SIGN_IN_ADDRESS_LIMIT,
        400,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
    }, 120_000);

    it(`POST /me/email/verify: ${AUTH_ATTEMPT_LIMIT} per email at one address, then 429`, async () => {
      const me = await customer();
      const from = address();
      const email = `new-${randomUUID()}@example.com`;
      const refused = await exhaust(
        () =>
          request(server())
            .post('/api/v1/me/email/verify')
            .set(me.auth)
            .set('X-Forwarded-For', from)
            .send({ email, code: '000000' }),
        AUTH_ATTEMPT_LIMIT,
        400,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
    });
  });

  describe('the signed-in customer’s writes, per customer', () => {
    it(`POST /me/photo: ${CUSTOMER_PHOTO_LIMIT}, counted before any upload is read`, async () => {
      const me = await customer();
      const refused = await exhaust(
        () => request(server()).post('/api/v1/me/photo').set(me.auth),
        CUSTOMER_PHOTO_LIMIT,
        400,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
    });

    it(`DELETE /me/photo: ${CUSTOMER_PHOTO_LIMIT}`, async () => {
      const me = await customer();
      const refused = await exhaust(
        () => request(server()).delete('/api/v1/me/photo').set(me.auth),
        CUSTOMER_PHOTO_LIMIT,
        200,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
    });

    it(`DELETE /me: ${ACCOUNT_DELETE_LIMIT}, so a refused deletion is not a loop`, async () => {
      const me = await customer();

      // An open bill refuses the deletion (409) every time.
      await prisma.order.create({
        data: {
          number: `CNCR-${randomBytes(4).toString('hex')}`,
          department: Department.RESTAURANT,
          label: 'Rate limits',
          businessDate: watToday(new Date()),
          status: OrderStatus.OPEN,
          vatBps: 750,
          serviceBps: 0,
          customerId: me.id,
        },
      });

      const refused = await exhaust(
        () => request(server()).delete('/api/v1/me').set(me.auth),
        ACCOUNT_DELETE_LIMIT,
        409,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
    });

    it(`POST /me/notifications/read: ${NOTIFICATIONS_READ_LIMIT}`, async () => {
      const me = await customer();
      const refused = await exhaust(
        () =>
          request(server()).post('/api/v1/me/notifications/read').set(me.auth),
        NOTIFICATIONS_READ_LIMIT,
        200,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
    }, 120_000);

    it(`PATCH /me/reservations/:id and POST …/cancel: ${BOOKING_CHANGE_LIMIT} each`, async () => {
      const me = await customer();
      const missing = `missing-${randomUUID()}`;

      expectRefused(
        await exhaust(
          () =>
            request(server())
              .patch(`/api/v1/me/reservations/${missing}`)
              .set(me.auth)
              .send({ version: 0, party: 2 }),
          BOOKING_CHANGE_LIMIT,
          404,
        ),
        FIFTEEN_MINUTES_S,
      );
      expectRefused(
        await exhaust(
          () =>
            request(server())
              .post(`/api/v1/me/reservations/${missing}/cancel`)
              .set(me.auth)
              .send({ version: 0 }),
          BOOKING_CHANGE_LIMIT,
          404,
        ),
        FIFTEEN_MINUTES_S,
      );
    }, 120_000);
  });

  describe('ordering', () => {
    it(`POST /ordering/quote: ${QUOTE_ADDRESS_LIMIT} per address, then 429 with Retry-After`, async () => {
      const from = address();
      const refused = await exhaust(
        () =>
          request(server())
            .post('/api/v1/ordering/quote')
            .set('X-Forwarded-For', from)
            .send({ lines: [], fulfilment: 'PICKUP' }),
        QUOTE_ADDRESS_LIMIT,
        400,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
      // Another address is not affected.
      await request(server())
        .post('/api/v1/ordering/quote')
        .set('X-Forwarded-For', address())
        .send({ lines: [], fulfilment: 'PICKUP' })
        .expect(400);
    }, 120_000);

    it(`POST /checkouts: ${CHECKOUT_ADDRESS_LIMIT} per address, then 429 with Retry-After`, async () => {
      const from = address();
      const refused = await exhaust(
        () =>
          request(server())
            .post('/api/v1/checkouts')
            .set('X-Forwarded-For', from)
            .set('Idempotency-Key', randomUUID())
            .send({ lines: [] }),
        CHECKOUT_ADDRESS_LIMIT,
        400,
      );

      expectRefused(refused, FIFTEEN_MINUTES_S);
    });

    it(`GET /checkouts/:reference: ${CHECKOUT_READ_ADDRESS_LIMIT} a minute per address, then 429 with Retry-After`, async () => {
      const from = address();
      const refused = await exhaust(
        () =>
          request(server())
            .get(`/api/v1/checkouts/cnc-order-${randomUUID()}`)
            .set('X-Forwarded-For', from),
        CHECKOUT_READ_ADDRESS_LIMIT,
        404,
      );

      expectRefused(refused, CHECKOUT_READ_WINDOW_MS / 1000);
    }, 120_000);
  });

  describe('the Paystack webhook', () => {
    const deliver = (raw: string, signature: string, from: string) =>
      request(server())
        .post('/api/v1/payments/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Forwarded-For', from)
        .set('x-paystack-signature', signature)
        .send(raw);

    const event = () =>
      JSON.stringify({
        event: 'transfer.success',
        data: { id: randomUUID(), reference: `limits-${randomUUID()}` },
      });

    it('never refuses a signed delivery for volume: far past the old ceiling, every replay is accepted and recorded once', async () => {
      const from = address();
      const raw = event();
      const signature = signPaystackBody(raw, PAYSTACK_KEY);

      for (let i = 0; i < WEBHOOK_BAD_SIGNATURE_LIMIT + 30; i += 1) {
        await deliver(raw, signature, from).expect(200);
      }
      await dispatcher.settled();

      const reference = (JSON.parse(raw) as { data: { reference: string } })
        .data.reference;

      expect(await prisma.paymentEvent.count({ where: { reference } })).toBe(1);
    }, 120_000);

    it(`counts bad signatures per address: ${WEBHOOK_BAD_SIGNATURE_LIMIT} a minute get 401, then 429 with Retry-After; a signed delivery from that address still lands`, async () => {
      const from = address();
      const refused = await exhaust(
        () => deliver(event(), 'not-a-signature', from),
        WEBHOOK_BAD_SIGNATURE_LIMIT,
        401,
      );

      expectRefused(refused, WEBHOOK_BAD_SIGNATURE_WINDOW_MS / 1000);
      // The signature is checked first, so the refused address's real
      // delivery is accepted and recorded.
      const raw = event();

      await deliver(raw, signPaystackBody(raw, PAYSTACK_KEY), from).expect(200);
      await dispatcher.settled();

      const reference = (JSON.parse(raw) as { data: { reference: string } })
        .data.reference;

      expect(await prisma.paymentEvent.count({ where: { reference } })).toBe(1);
      // Another address's bad signature is still a plain 401.
      await deliver(event(), 'not-a-signature', address()).expect(401);
    }, 120_000);
  });

  it('stores every count under a digest, never an address or an email in the clear', async () => {
    const rows = await prisma.rateLimitCount.findMany({
      select: { key: true },
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.key).toMatch(/^[^:]+:[0-9a-f]{64}$/);
    }
  });
});
