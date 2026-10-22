import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { buildCncDocument } from '../src/cnc-swagger';
import { IDEMPOTENCY_KEY_REQUIRED } from '../src/idempotency/idempotency-key.decorator';
import { idempotencyScope } from '../src/idempotency/idempotency-scope';
import { IDEMPOTENCY_KEY_REUSED } from '../src/idempotency/idempotency.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp } from './create-test-app';
import {
  PROBE_PATH,
  REPLAYED_HEADER,
  SCOPE_HEADER,
  StockItemProbeController,
} from './stock-item-probe.controller';

/**
 * `Idempotency-Key` (A9) through HTTP and against Postgres: the first
 * response is stored with the key and returned again for a repeat, a
 * different request under the same key is a 409, and two copies sent at once
 * run the command once.
 *
 * The route is the test-only probe, which creates a stock item; real routes
 * (order create, payments, checkout, reservations) use the same service.
 * Names, keys and scopes are run-unique, and nothing is removed.
 */
describe('idempotency (e2e)', () => {
  const ALLOWED = 'https://allowed.example';
  const originalOrigins = process.env.CNC_CORS_ORIGINS;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  beforeAll(async () => {
    process.env.CNC_CORS_ORIGINS = ALLOWED;
    app = await createTestApp({ controllers: [StockItemProbeController] });
    prisma = app.get(CncPrismaService);
  });

  afterAll(async () => {
    await app.close();
    if (originalOrigins === undefined) delete process.env.CNC_CORS_ORIGINS;
    else process.env.CNC_CORS_ORIGINS = originalOrigins;
  });

  /** A run-unique caller, so no other test's keys are in scope. */
  const caller = () => `idem-${randomUUID()}`;

  const create = (
    key: string | undefined,
    body: Record<string, unknown>,
    scope: string,
  ) => {
    const call = request(app.getHttpServer())
      .post(`/api/v1/${PROBE_PATH}`)
      .set(SCOPE_HEADER, scope)
      .send(body);

    return key === undefined ? call : call.set('Idempotency-Key', key);
  };

  const itemsNamed = (name: string) =>
    prisma.stockItem.count({ where: { name } });

  it('runs a command once and returns the stored response to a repeat', async () => {
    const scope = caller();
    const key = randomUUID();
    const body = { name: `idem-probe-${randomUUID()}`, factor: 2 };

    const first = await create(key, body, scope).expect(201);
    const second = await create(key, body, scope).expect(201);

    expect(first.headers[REPLAYED_HEADER]).toBe('false');
    expect(second.headers[REPLAYED_HEADER]).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(typeof (first.body as { createdAt: unknown }).createdAt).toBe(
      'string',
    );
    expect(await itemsNamed(body.name)).toBe(1);

    const stored = await prisma.idempotencyKey.findUniqueOrThrow({
      where: {
        scope_key: { scope: idempotencyScope.staff(scope), key },
      },
    });
    expect(stored.route).toBe(`POST /api/v1/${PROBE_PATH}`);
    expect(stored.responseStatus).toBe(201);
    expect(stored.responseBody).toEqual(first.body);
  });

  it('treats one key in upper and lower case as the same key', async () => {
    const scope = caller();
    const key = randomUUID();
    const body = { name: `idem-probe-${randomUUID()}`, factor: 1 };

    const first = await create(key, body, scope).expect(201);
    const second = await create(key.toUpperCase(), body, scope).expect(201);

    expect(second.body).toEqual(first.body);
    expect(await itemsNamed(body.name)).toBe(1);
  });

  it('refuses the same key with a different request with 409, running nothing', async () => {
    const scope = caller();
    const key = randomUUID();
    const name = `idem-probe-${randomUUID()}`;

    await create(key, { name, factor: 1 }, scope).expect(201);
    const other = `idem-probe-${randomUUID()}`;
    const response = await create(
      key,
      { name: other, factor: 1 },
      scope,
    ).expect(409);

    expect(response.body).toMatchObject({
      statusCode: 409,
      message: IDEMPOTENCY_KEY_REUSED,
    });
    expect(await itemsNamed(other)).toBe(0);
  });

  it('runs a command once when two copies arrive at the same moment', async () => {
    const scope = caller();
    const key = randomUUID();
    // The command holds its transaction open, so the second copy necessarily
    // arrives while the first is still running and has to wait for it.
    const body = { name: `idem-probe-${randomUUID()}`, factor: 3, holdMs: 500 };

    const [a, b] = await Promise.all([
      create(key, body, scope),
      create(key, body, scope),
    ]);

    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body).toEqual(a.body);
    expect(
      [a.headers[REPLAYED_HEADER], b.headers[REPLAYED_HEADER]].sort(),
    ).toEqual(['false', 'true']);
    expect(await itemsNamed(body.name)).toBe(1);
  });

  it('keeps one caller’s key apart from another’s', async () => {
    const key = randomUUID();
    const nameA = `idem-probe-${randomUUID()}`;
    const nameB = `idem-probe-${randomUUID()}`;

    const a = await create(key, { name: nameA, factor: 1 }, caller()).expect(
      201,
    );
    const b = await create(key, { name: nameB, factor: 1 }, caller()).expect(
      201,
    );

    expect(a.headers[REPLAYED_HEADER]).toBe('false');
    expect(b.headers[REPLAYED_HEADER]).toBe('false');
    expect((b.body as { id: string }).id).not.toBe(
      (a.body as { id: string }).id,
    );
  });

  it('stores nothing for a refused command, so the key can be used again', async () => {
    const scope = caller();
    const key = randomUUID();
    const name = `idem-probe-${randomUUID()}`;

    const refused = await create(
      key,
      { name, factor: 1, refuse: true },
      scope,
    ).expect(409);
    expect((refused.body as { message: unknown }).message).toBe(
      'The probe refused.',
    );
    expect(await itemsNamed(name)).toBe(0);
    expect(
      await prisma.idempotencyKey.count({
        where: { scope: idempotencyScope.staff(scope), key },
      }),
    ).toBe(0);

    // A corrected request under the same key runs, rather than replaying
    // the refusal or being called a different request.
    await create(key, { name, factor: 1 }, scope).expect(201);
    expect(await itemsNamed(name)).toBe(1);
  });

  it.each([
    ['without the header', undefined],
    ['with a key that is not a UUID', 'retry-1'],
  ])('refuses a request %s with 400', async (_label, key) => {
    const name = `idem-probe-${randomUUID()}`;

    const response = await create(key, { name, factor: 1 }, caller()).expect(
      400,
    );

    expect(response.body).toMatchObject({
      statusCode: 400,
      message: IDEMPOTENCY_KEY_REQUIRED,
    });
    expect(await itemsNamed(name)).toBe(0);
  });

  it('documents the header, and a browser can preflight every route that takes it', async () => {
    const document = buildCncDocument(app);
    const routes: { path: string; method: string }[] = [];

    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const parameters = (
          operation as { parameters?: { in?: string; name?: string }[] }
        ).parameters;

        if (
          parameters?.some(
            (p) => p.in === 'header' && p.name === 'Idempotency-Key',
          )
        ) {
          routes.push({ path, method: method.toUpperCase() });
        }
      }
    }

    expect(routes).toContainEqual({
      path: `/api/v1/${PROBE_PATH}`,
      method: 'POST',
    });
    // The first public one (C6-5): the site's booking, which a browser on
    // the site calls with no session, so it is pinned by name.
    expect(routes).toContainEqual({
      path: '/api/v1/reservations',
      method: 'POST',
    });

    for (const route of routes) {
      const response = await request(app.getHttpServer())
        .options(route.path)
        .set('Origin', ALLOWED)
        .set('Access-Control-Request-Method', route.method)
        .set('Access-Control-Request-Headers', 'content-type,idempotency-key');

      expect(response.status).toBeLessThan(300);
      expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(
        String(response.headers['access-control-allow-headers']).toLowerCase(),
      ).toContain('idempotency-key');
    }
  });
});
