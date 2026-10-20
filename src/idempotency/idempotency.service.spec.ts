import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '../../generated/cnc-client';
import type { CncPrismaService } from '../prisma/cnc-prisma.service';
import {
  IDEMPOTENCY_KEY_REUSED,
  IDEMPOTENCY_KEY_TTL_DAYS,
  IdempotencyService,
} from './idempotency.service';

/**
 * The decisions the service makes, against a fake client. The real
 * transaction behaviour (the key and the command committing together, a
 * concurrent duplicate waiting and replaying) is checked against Postgres in
 * `test/idempotency.e2e-spec.ts`.
 */
function uniqueViolation(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: { target },
  });
}

interface StoredRow {
  route: string;
  requestHash: string;
  responseStatus: number | null;
  responseBody: unknown;
}

function fakePrisma(options: {
  createError?: Error;
  stored?: StoredRow | null;
}) {
  const tx = {
    idempotencyKey: {
      create: jest.fn(() =>
        options.createError
          ? Promise.reject(options.createError)
          : Promise.resolve({ id: 'row-1' }),
      ),
      update: jest.fn(() => Promise.resolve({})),
    },
  };
  const prisma = {
    $transaction: jest.fn(
      (fn: (client: typeof tx) => Promise<unknown>, options?: unknown) => {
        void options;
        return fn(tx);
      },
    ),
    idempotencyKey: {
      findUnique: jest.fn(() => Promise.resolve(options.stored ?? null)),
      deleteMany: jest.fn(() => Promise.resolve({ count: 2 })),
    },
  };

  return {
    service: new IdempotencyService(prisma as unknown as CncPrismaService),
    prisma,
    tx,
  };
}

const COMMAND = {
  scope: 'staff:abc',
  // Generated rather than written out: a literal UUID beside the word "key"
  // reads as a credential to the pre-commit secret scan.
  key: randomUUID(),
  route: 'POST /api/v1/staff/orders',
  requestHash: 'hash-1',
  status: 201,
};

describe('IdempotencyService.execute', () => {
  it('runs the command once, stores its response in the same transaction, and returns it', async () => {
    const { service, tx, prisma } = fakePrisma({});
    const work = jest.fn(() =>
      Promise.resolve({ number: 'CNCR-000001', at: new Date(0) }),
    );

    const result = await service.execute({ ...COMMAND, work });

    expect(work).toHaveBeenCalledWith(tx);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.idempotencyKey.create).toHaveBeenCalledWith({
      data: {
        scope: 'staff:abc',
        key: COMMAND.key,
        route: COMMAND.route,
        requestHash: 'hash-1',
      },
      select: { id: true },
    });
    expect(tx.idempotencyKey.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: {
        responseStatus: 201,
        responseBody: { number: 'CNCR-000001', at: '1970-01-01T00:00:00.000Z' },
      },
    });
    // The first caller gets the JSON form too, so a replay is identical.
    expect(result).toEqual({
      status: 201,
      body: { number: 'CNCR-000001', at: '1970-01-01T00:00:00.000Z' },
      replayed: false,
    });
  });

  it('inserts the key before the command runs', async () => {
    const { service, tx } = fakePrisma({});
    const order: string[] = [];
    tx.idempotencyKey.create.mockImplementation(() => {
      order.push('key');
      return Promise.resolve({ id: 'row-1' });
    });

    await service.execute({
      ...COMMAND,
      work: () => {
        order.push('command');
        return Promise.resolve({});
      },
    });

    expect(order).toEqual(['key', 'command']);
  });

  it('stores an empty body as JSON null', async () => {
    const { service, tx } = fakePrisma({});

    const result = await service.execute({
      ...COMMAND,
      work: () => Promise.resolve(undefined),
    });

    expect(tx.idempotencyKey.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { responseStatus: 201, responseBody: Prisma.JsonNull },
    });
    expect(result.body).toBeNull();
  });

  it('replays the stored response for a repeat of the same request, without running the command', async () => {
    const { service } = fakePrisma({
      createError: uniqueViolation(['scope', 'key']),
      stored: {
        route: COMMAND.route,
        requestHash: 'hash-1',
        responseStatus: 201,
        responseBody: { number: 'CNCR-000001' },
      },
    });
    const work = jest.fn();

    await expect(service.execute({ ...COMMAND, work })).resolves.toEqual({
      status: 201,
      body: { number: 'CNCR-000001' },
      replayed: true,
    });
    expect(work).not.toHaveBeenCalled();
  });

  it.each([
    ['a different request', { requestHash: 'hash-2' }],
    ['a different route', { route: 'POST /api/v1/staff/orders/:id/settle' }],
  ])('refuses the same key with %s with 409', async (_label, difference) => {
    const { service } = fakePrisma({
      createError: uniqueViolation(['scope', 'key']),
      stored: {
        route: COMMAND.route,
        requestHash: 'hash-1',
        responseStatus: 201,
        responseBody: {},
      },
    });

    const failure = service.execute({
      ...COMMAND,
      ...difference,
      work: jest.fn(),
    });

    await expect(failure).rejects.toBeInstanceOf(ConflictException);
    await expect(failure).rejects.toThrow(IDEMPOTENCY_KEY_REUSED);
  });

  it('refuses with 409 when the clashing row has gone', async () => {
    const { service } = fakePrisma({
      createError: uniqueViolation(['scope', 'key']),
      stored: null,
    });

    await expect(
      service.execute({ ...COMMAND, work: jest.fn() }),
    ).rejects.toThrow(IDEMPOTENCY_KEY_REUSED);
  });

  it('passes on a unique violation from the command’s own write', async () => {
    const clash = uniqueViolation(['name']);
    const { service, prisma } = fakePrisma({});

    await expect(
      service.execute({ ...COMMAND, work: () => Promise.reject(clash) }),
    ).rejects.toBe(clash);
    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
  });

  it('passes on a refusal from the command, storing nothing', async () => {
    const refusal = new ConflictException(
      'This record changed. Refresh and try again.',
    );
    const { service, tx } = fakePrisma({});

    await expect(
      service.execute({ ...COMMAND, work: () => Promise.reject(refusal) }),
    ).rejects.toBe(refusal);
    expect(tx.idempotencyKey.update).not.toHaveBeenCalled();
  });

  it('hands the transaction options to Prisma', async () => {
    const { service, prisma } = fakePrisma({});

    await service.execute({
      ...COMMAND,
      work: () => Promise.resolve({}),
      transaction: { timeout: 10_000 },
    });

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 10_000,
    });
  });
});

describe('IdempotencyService.deleteExpired', () => {
  it(`deletes rows older than ${IDEMPOTENCY_KEY_TTL_DAYS} days`, async () => {
    const { service, prisma } = fakePrisma({});

    await expect(
      service.deleteExpired(new Date('2026-10-20T12:00:00.000Z')),
    ).resolves.toBe(2);
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date('2026-10-13T12:00:00.000Z') } },
    });
  });
});
