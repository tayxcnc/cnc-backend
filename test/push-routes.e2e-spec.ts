import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { StaffRole, SubjectType } from '../generated/cnc-client';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';
import { PUSH_KEYS_MESSAGE } from '../src/push/dto/push.dto';
import { staffPushEventsFor } from '../src/push/push-catalogue';
import { PUSH_ENDPOINT_MESSAGE } from '../src/push/push-hosts';
import {
  MAX_PUSH_DEVICES_PER_OWNER,
  PUSH_KEY_MISMATCH_MESSAGE,
  PUSH_NOT_CONFIGURED_MESSAGE,
} from '../src/push/push-subscriptions.service';
import { createTestApp } from './create-test-app';
import { fcmPrefix, testSubscription } from './push-devices';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';
import { testVapidTrio } from './vapid-test-pair';

/**
 * The web push routes (C10, spec §2.5): each realm's public key and
 * subscribe and unsubscribe, through HTTP on the shared database.
 *
 * Every row this suite writes is its own (run-unique endpoints and
 * people), so it asserts on its own rows only. The served key is the test
 * pair's (`createTestApp`); a second app serves none, as a service without
 * `CNC_VAPID_*` does.
 */
describe('Web push routes (e2e)', () => {
  let app: INestApplication<App>;
  let unconfigured: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;

  const ME = '/api/v1/me/push';
  const STAFF = '/api/v1/staff/push';
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = await createTestApp();
    unconfigured = await createTestApp({ push: 'unconfigured' });
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });
  });

  afterAll(async () => {
    await app?.close();
    await unconfigured?.close();
  });

  /** A live, verified customer with a session (so a refresh token). */
  const customer = async () => {
    const row = await prisma.customer.create({
      data: {
        memberNo: await drawNumber(prisma, 'customer'),
        name: 'Push Routes',
        email: `push-routes-${randomUUID()}@cnc.test`,
        emailVerifiedAt: new Date(),
      },
    });
    const { accessToken } = await tokens.issueTokenPair(
      row.id,
      SubjectType.CUSTOMER,
    );

    return { id: row.id, auth: { Authorization: `Bearer ${accessToken}` } };
  };

  const staff = async (role: StaffRole = StaffRole.MANAGER) => {
    const account = await createStaffAccount(prisma, role, {
      emailPrefix: 'push-routes',
    });

    return {
      id: account.id,
      auth: {
        Authorization: `Bearer ${await accessTokenFor(tokens, account.id)}`,
      },
    };
  };

  /** Every body a push route answered: none may carry a secret. */
  const bodies: string[] = [];
  const keep = (response: request.Response) => {
    bodies.push(JSON.stringify(response.body ?? null) + response.text);
    return response;
  };

  describe('the realms', () => {
    const routes = (base: string) => [
      { method: 'get' as const, path: `${base}/public-key` },
      { method: 'post' as const, path: `${base}/subscriptions` },
      { method: 'delete' as const, path: `${base}/subscriptions` },
    ];

    it('answers 401 with no token on every route', async () => {
      for (const route of [...routes(ME), ...routes(STAFF)]) {
        await request(server())
          [route.method](route.path)
          .send(testSubscription())
          .expect(401);
      }
    });

    it('answers 403 to a staff token on the customer’s routes, and to a customer’s on staff’s', async () => {
      const me = await customer();
      const them = await staff();

      for (const route of routes(ME)) {
        await request(server())
          [route.method](route.path)
          .set(them.auth)
          .send(testSubscription())
          .expect(403);
      }

      for (const route of routes(STAFF)) {
        await request(server())
          [route.method](route.path)
          .set(me.auth)
          .send(testSubscription())
          .expect(403);
      }
    });
  });

  describe('the public key', () => {
    it('serves the configured key to a customer, never cached', async () => {
      const me = await customer();
      const response = keep(
        await request(server())
          .get(`${ME}/public-key`)
          .set(me.auth)
          .expect(200),
      );

      expect(response.body).toEqual({ publicKey: testVapidTrio().publicKey });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('answers 404 in both realms where push is not configured', async () => {
      const me = await customer();
      const them = await staff();

      for (const [path, auth] of [
        [`${ME}/public-key`, me.auth],
        [`${STAFF}/public-key`, them.auth],
      ] as const) {
        const response = await request(unconfigured.getHttpServer())
          .get(path)
          .set(auth)
          .expect(404);

        expect((response.body as { message: string }).message).toBe(
          PUSH_NOT_CONFIGURED_MESSAGE,
        );
      }

      await request(unconfigured.getHttpServer())
        .post(`${ME}/subscriptions`)
        .set(me.auth)
        .send(testSubscription())
        .expect(404);
    });

    it('lists the staff events of the role on the account now, not the token’s', async () => {
      const waiter = await staff(StaffRole.WAITER);
      const first = keep(
        await request(server())
          .get(`${STAFF}/public-key`)
          .set(waiter.auth)
          .expect(200),
      );

      expect(first.body).toEqual({
        publicKey: testVapidTrio().publicKey,
        events: [],
      });

      await prisma.staff.update({
        where: { id: waiter.id },
        data: { role: StaffRole.CASHIER },
      });

      const after = keep(
        await request(server())
          .get(`${STAFF}/public-key`)
          .set(waiter.auth)
          .expect(200),
      );

      expect(after.body).toEqual({
        publicKey: testVapidTrio().publicKey,
        events: staffPushEventsFor(StaffRole.CASHIER),
      });
      const events = (after.body as { events: string[] }).events;

      expect(events).toEqual(
        expect.arrayContaining(['online_order.received', 'orders.unsettled']),
      );
      expect(events).not.toContain('checkout.needs_attention');
    });
  });

  describe('subscribing', () => {
    const subscribe = (
      base: string,
      auth: Record<string, string>,
      body: unknown,
      status: number,
    ) =>
      request(server())
        .post(`${base}/subscriptions`)
        .set(auth)
        .set('User-Agent', 'Push routes e2e')
        .send(body as object)
        .expect(status)
        .then(keep);

    it('stores a customer’s device with 204, and refreshes it on a second subscribe', async () => {
      const me = await customer();
      const sub = testSubscription();

      await subscribe(ME, me.auth, sub, 204);
      await subscribe(ME, me.auth, sub, 204);

      const rows = await prisma.customerPushSubscription.findMany({
        where: { customerId: me.id },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: 'Push routes e2e',
      });
    });

    it('moves an endpoint to another customer only when the keys match', async () => {
      const a = await customer();
      const b = await customer();
      const sub = testSubscription();

      await subscribe(ME, a.auth, sub, 204);

      // B names A's endpoint with keys of its own: nothing moves.
      await subscribe(
        ME,
        b.auth,
        { ...testSubscription(sub.endpoint), endpoint: sub.endpoint },
        204,
      );

      const kept = await prisma.customerPushSubscription.findUniqueOrThrow({
        where: { endpoint: sub.endpoint },
      });

      expect(kept.customerId).toBe(a.id);
      expect(kept.p256dh).toBe(sub.keys.p256dh);

      // The same browser, signed in as B: the keys match, so it moves.
      await subscribe(ME, b.auth, sub, 204);
      expect(
        (
          await prisma.customerPushSubscription.findUniqueOrThrow({
            where: { endpoint: sub.endpoint },
          })
        ).customerId,
      ).toBe(b.id);
    });

    it('moves a shared tablet between staff the same way', async () => {
      const a = await staff(StaffRole.CASHIER);
      const b = await staff(StaffRole.KITCHEN);
      const sub = testSubscription();

      await subscribe(STAFF, a.auth, sub, 204);
      await subscribe(
        STAFF,
        b.auth,
        { ...testSubscription(sub.endpoint), endpoint: sub.endpoint },
        204,
      );
      expect(
        (
          await prisma.staffPushSubscription.findUniqueOrThrow({
            where: { endpoint: sub.endpoint },
          })
        ).staffId,
      ).toBe(a.id);

      await subscribe(STAFF, b.auth, sub, 204);
      expect(
        (
          await prisma.staffPushSubscription.findUniqueOrThrow({
            where: { endpoint: sub.endpoint },
          })
        ).staffId,
      ).toBe(b.id);
    });

    it('refuses an endpoint off the push-service list with 400', async () => {
      const me = await customer();

      for (const endpoint of [
        'https://127.0.0.1/push',
        'https://[::1]/push',
        'https://169.254.169.254/latest',
        'https://localhost/push',
        'https://user:pass@fcm.googleapis.com/fcm/send/x',
        'https://fcm.googleapis.com:8443/fcm/send/x',
        'https://evil.example/',
        'http://fcm.googleapis.com/fcm/send/x',
      ]) {
        const response = await subscribe(
          ME,
          me.auth,
          testSubscription(endpoint),
          400,
        );

        // The DTO answers a field's sentence in a list; the service alone.
        expect(
          [(response.body as { message: unknown }).message].flat(),
        ).toEqual([PUSH_ENDPOINT_MESSAGE]);
      }

      expect(
        await prisma.customerPushSubscription.count({
          where: { customerId: me.id },
        }),
      ).toBe(0);
    });

    it('refuses keys of the wrong length with 400', async () => {
      const me = await customer();
      const sub = testSubscription();

      for (const keys of [
        { ...sub.keys, p256dh: randomBytes(64).toString('base64url') },
        { ...sub.keys, auth: randomBytes(15).toString('base64url') },
        { ...sub.keys, auth: 'not base64!' },
      ]) {
        const response = await subscribe(ME, me.auth, { ...sub, keys }, 400);

        expect(
          [(response.body as { message: unknown }).message].flat(),
        ).toEqual([PUSH_KEYS_MESSAGE]);
      }
    });

    it('answers 409 to a subscription made with another key', async () => {
      const me = await customer();
      const other = randomBytes(65);

      other[0] = 4;

      const response = await subscribe(
        ME,
        me.auth,
        {
          ...testSubscription(),
          applicationServerKey: other.toString('base64url'),
        },
        409,
      );

      expect((response.body as { message: string }).message).toBe(
        PUSH_KEY_MISMATCH_MESSAGE,
      );
      expect(
        await prisma.customerPushSubscription.count({
          where: { customerId: me.id },
        }),
      ).toBe(0);
    });

    it('accepts the served key padded with "=": the bytes are compared, not the text', async () => {
      const me = await customer();
      const sub = testSubscription();

      await subscribe(
        ME,
        me.auth,
        { ...sub, applicationServerKey: `${sub.applicationServerKey}=` },
        204,
      );

      expect(
        await prisma.customerPushSubscription.count({
          where: { customerId: me.id },
        }),
      ).toBe(1);
    });

    it(`keeps ${MAX_PUSH_DEVICES_PER_OWNER} devices: the next evicts the least recently seen`, async () => {
      const me = await customer();
      const prefix = fcmPrefix();
      const endpoints: string[] = [];

      for (let n = 0; n <= MAX_PUSH_DEVICES_PER_OWNER; n += 1) {
        endpoints.push(`${prefix}-${n}`);
        await subscribe(ME, me.auth, testSubscription(endpoints[n]), 204);
        // Apart in time, so "least recently seen" is one device.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const kept = (
        await prisma.customerPushSubscription.findMany({
          where: { customerId: me.id },
          select: { endpoint: true },
        })
      ).map(({ endpoint }) => endpoint);

      expect(kept).toHaveLength(MAX_PUSH_DEVICES_PER_OWNER);
      expect(kept).not.toContain(endpoints[0]);
      expect(kept).toEqual(expect.arrayContaining(endpoints.slice(1)));
    });

    it('answers 429 to the 31st subscribe in 15 minutes, per customer and per staff member', async () => {
      const me = await customer();
      const them = await staff(StaffRole.KITCHEN);
      const mine = testSubscription();
      const theirs = testSubscription();

      for (let n = 0; n < 30; n += 1) {
        await subscribe(ME, me.auth, mine, 204);
        await subscribe(STAFF, them.auth, theirs, 204);
      }

      await subscribe(ME, me.auth, mine, 429);
      await subscribe(STAFF, them.auth, theirs, 429);

      // Another customer is not held back by this one's count.
      await subscribe(ME, (await customer()).auth, testSubscription(), 204);
    });
  });

  describe('unsubscribing', () => {
    it('removes only the caller’s own device, and answers 204 either way', async () => {
      const a = await customer();
      const b = await customer();
      const sub = testSubscription();

      await request(server())
        .post(`${ME}/subscriptions`)
        .set(a.auth)
        .send(sub)
        .expect(204)
        .then(keep);

      // B cannot remove A's device by naming it.
      await request(server())
        .delete(`${ME}/subscriptions`)
        .set(b.auth)
        .send({ endpoint: sub.endpoint })
        .expect(204)
        .then(keep);
      expect(
        await prisma.customerPushSubscription.count({
          where: { endpoint: sub.endpoint },
        }),
      ).toBe(1);

      await request(server())
        .delete(`${ME}/subscriptions`)
        .set(a.auth)
        .send({ endpoint: sub.endpoint })
        .expect(204)
        .then(keep);
      expect(
        await prisma.customerPushSubscription.count({
          where: { endpoint: sub.endpoint },
        }),
      ).toBe(0);
    });

    it('removes a staff member’s own device', async () => {
      const them = await staff(StaffRole.STOREKEEPER);
      const sub = testSubscription();

      await request(server())
        .post(`${STAFF}/subscriptions`)
        .set(them.auth)
        .send(sub)
        .expect(204);
      await request(server())
        .delete(`${STAFF}/subscriptions`)
        .set(them.auth)
        .send({ endpoint: sub.endpoint })
        .expect(204)
        .then(keep);

      expect(
        await prisma.staffPushSubscription.count({
          where: { staffId: them.id },
        }),
      ).toBe(0);
    });
  });

  // Last, over every answer the tests above kept.
  it('never answers with an endpoint, a key, a dedupe key or a status', () => {
    expect(bodies.length).toBeGreaterThan(40);

    for (const body of bodies) {
      for (const field of [
        'p256dh',
        '"auth"',
        '"endpoint"',
        'applicationServerKey',
        'dedupeKey',
        '"status"',
        'fcm.googleapis.com',
      ]) {
        expect(body).not.toContain(field);
      }
    }
  });
});
