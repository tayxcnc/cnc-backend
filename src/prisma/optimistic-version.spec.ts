import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/cnc-client';
import {
  claimVersion,
  STALE_VERSION_MESSAGE,
  VERSIONED_TABLES,
  type VersionedTable,
} from './optimistic-version';

/**
 * The decisions `claimVersion` makes from what Postgres answers, with a fake
 * client. That the single UPDATE really refuses the second of two concurrent
 * writers is checked against Postgres in `test/optimistic-version.e2e-spec.ts`.
 */
function fakeTx(answers: unknown[][]) {
  const queue = [...answers];
  const $queryRawUnsafe = jest.fn((query: string, ...values: unknown[]) => {
    void query;
    void values;
    return Promise.resolve(queue.shift() ?? []);
  });

  return {
    tx: { $queryRawUnsafe } as unknown as Parameters<typeof claimVersion>[0],
    $queryRawUnsafe,
  };
}

const CLAIM = {
  table: 'StockItem',
  id: 'item-1',
  version: 3,
  notFound: 'Stock item not found.',
} as const;

describe('claimVersion', () => {
  it('checks and increments the version in one UPDATE, and returns the new one', async () => {
    const { tx, $queryRawUnsafe } = fakeTx([[{ version: 4 }]]);

    await expect(claimVersion(tx, CLAIM)).resolves.toBe(4);

    expect($queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, id, version] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/^UPDATE "StockItem"/);
    expect(sql).toContain('"version" = "version" + 1');
    expect(sql).toContain('WHERE "id" = $1 AND "version" = $2');
    expect(sql).toContain(`(now() AT TIME ZONE 'UTC')`);
    expect([id, version]).toEqual(['item-1', 3]);
  });

  it('refuses a stale version with 409 and the fixed sentence', async () => {
    const { tx } = fakeTx([[], [{ found: 1 }]]);

    const failure = claimVersion(tx, CLAIM);

    await expect(failure).rejects.toBeInstanceOf(ConflictException);
    await expect(failure).rejects.toThrow(
      'This record changed. Refresh and try again.',
    );
    expect(STALE_VERSION_MESSAGE).toBe(
      'This record changed. Refresh and try again.',
    );
  });

  it('answers a missing row with 404 and the command’s own sentence', async () => {
    const { tx } = fakeTx([[], []]);

    const failure = claimVersion(tx, CLAIM);

    await expect(failure).rejects.toBeInstanceOf(NotFoundException);
    await expect(failure).rejects.toThrow('Stock item not found.');
  });

  it('refuses a table that is not on the list before any query', async () => {
    const { tx, $queryRawUnsafe } = fakeTx([]);

    await expect(
      claimVersion(tx, {
        ...CLAIM,
        table: 'AuditLog"; DROP TABLE "Staff' as VersionedTable,
      }),
    ).rejects.toThrow(/is not a versioned table/);
    expect($queryRawUnsafe).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 53])(
    'refuses a version of %p with 400 before any query',
    async (version) => {
      const { tx, $queryRawUnsafe } = fakeTx([]);

      await expect(
        claimVersion(tx, { ...CLAIM, version }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect($queryRawUnsafe).not.toHaveBeenCalled();
    },
  );
});

describe('VERSIONED_TABLES', () => {
  it('is exactly the models whose rows carry a version', () => {
    const withVersion = Prisma.dmmf.datamodel.models
      .filter((model) => model.fields.some((field) => field.name === 'version'))
      .map((model) => model.name)
      .sort();

    expect([...VERSIONED_TABLES].sort()).toEqual(withVersion);
  });
});
