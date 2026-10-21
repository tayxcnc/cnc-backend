import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { VERSION_FIELD_MESSAGE } from '../src/common/dto/versioned-write.dto';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { createTestApp } from './create-test-app';
import {
  PROBE_PATH,
  StockItemProbeController,
} from './stock-item-probe.controller';

/**
 * Optimistic concurrency (A8) through HTTP and against Postgres: a write
 * names the version it read, and a stale one is refused with 409 and the
 * fixed sentence. The acceptance case is two cashiers settling the same bill
 * (BE §2, §12), here two edits of one stock item sent at the same moment.
 *
 * The routes are the test-only probe; real commands use `claimVersion` the
 * same way. Every row is created under a run-unique name and never removed.
 */
describe('optimistic version (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  beforeAll(async () => {
    app = await createTestApp({ controllers: [StockItemProbeController] });
    prisma = app.get(CncPrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function newItem(): Promise<{ id: string; version: number }> {
    return prisma.stockItem.create({
      data: {
        name: `version-probe-${randomUUID()}`,
        kind: 'KITCHEN',
        unit: 'portion',
        pack: 'pack',
        factor: 1,
        minimum: 0,
      },
      select: { id: true, version: true },
    });
  }

  const patch = (id: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(`/api/v1/${PROBE_PATH}/${id}`)
      .send(body);

  it('accepts a write naming the current version, and moves the version on', async () => {
    const item = await newItem();
    expect(item.version).toBe(0);

    const response = await patch(item.id, { version: 0, minimum: 5 }).expect(
      200,
    );

    expect(response.body).toEqual({ id: item.id, minimum: 5, version: 1 });

    const stored = await prisma.stockItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect([stored.version, stored.minimum]).toEqual([1, 5]);
  });

  it('refuses a stale version with 409 and the fixed sentence, changing nothing', async () => {
    const item = await newItem();
    await patch(item.id, { version: 0, minimum: 5 }).expect(200);

    const response = await patch(item.id, { version: 0, minimum: 9 }).expect(
      409,
    );

    expect(response.body).toMatchObject({
      statusCode: 409,
      message: 'This record changed. Refresh and try again.',
    });
    expect(STALE_VERSION_MESSAGE).toBe(
      'This record changed. Refresh and try again.',
    );

    const stored = await prisma.stockItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect([stored.version, stored.minimum]).toEqual([1, 5]);
  });

  it('lets exactly one of two simultaneous writes on one version through', async () => {
    const item = await newItem();

    // Each holds its transaction open after the claim, so the second
    // necessarily arrives while the first still holds the row.
    const [a, b] = await Promise.all([
      patch(item.id, { version: 0, minimum: 1, holdMs: 400 }),
      patch(item.id, { version: 0, minimum: 2, holdMs: 400 }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    const winner = a.status === 200 ? a : b;
    expect((loser.body as { message: unknown }).message).toBe(
      STALE_VERSION_MESSAGE,
    );

    const stored = await prisma.stockItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(stored.version).toBe(1);
    expect(stored.minimum).toBe((winner.body as { minimum: number }).minimum);
  });

  it('answers a record that does not exist with 404 and the command’s sentence', async () => {
    const response = await patch(`missing-${randomUUID()}`, {
      version: 0,
      minimum: 1,
    }).expect(404);

    expect(response.body).toMatchObject({
      statusCode: 404,
      message: 'Stock item not found.',
    });
  });

  it.each([
    ['missing', {}],
    ['negative', { version: -1 }],
    ['fractional', { version: 0.5 }],
  ])('refuses a version that is %s with 400', async (_label, version) => {
    const item = await newItem();

    const response = await patch(item.id, { ...version, minimum: 1 }).expect(
      400,
    );

    expect((response.body as { message: string[] }).message).toContain(
      VERSION_FIELD_MESSAGE,
    );
  });
});
