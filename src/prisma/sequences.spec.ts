import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drawNumber, SEQUENCES } from './sequences';

/**
 * The sequence list against the migrations that create the sequences, and
 * the formatting of a drawn number. Whether `nextval` itself hands concurrent
 * callers different numbers is checked against Postgres in
 * `test/schema.e2e-spec.ts`.
 */
const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

function allMigrationSql(): string {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8'),
    )
    .join('\n');
}

describe('SEQUENCES', () => {
  const entries = Object.entries(SEQUENCES);

  it('names each prefix the plan lists, once', () => {
    // Plan §4, "Sequences": CNCR, CNCB, WEB, PAY, CASH, RSV, SR, PR, W, T,
    // MT, CNC-S (staff) and CNC- (customer). Written out here rather than
    // derived, so dropping one from SEQUENCES fails this test.
    expect(entries.map(([, s]) => s.prefix).sort()).toEqual(
      [
        'CNCR-',
        'CNCB-',
        'WEB-',
        'PAY-',
        'CASH-',
        'RSV-',
        'SR-',
        'PR-',
        'W-',
        'T-',
        'MT-',
        'CNC-S',
        'CNC-',
      ].sort(),
    );
  });

  it('uses each sequence for one kind of number only', () => {
    const names = entries.map(([, s]) => s.sequence);

    expect(new Set(names).size).toBe(names.length);
  });

  it('gives staff numbers 3 digits and every other number 6', () => {
    for (const [name, s] of entries) {
      expect([name, s.minDigits]).toEqual([name, name === 'staff' ? 3 : 6]);
    }
  });

  it('names only sequences a migration creates', () => {
    const sql = allMigrationSql();

    for (const [, s] of entries) {
      expect(sql).toContain(`CREATE SEQUENCE "${s.sequence}"`);
    }
  });
});

describe('drawNumber', () => {
  function fakePrisma(next: bigint) {
    const $queryRawUnsafe = jest.fn((query: string) => {
      void query;
      return Promise.resolve([{ next }]);
    });

    return {
      prisma: { $queryRawUnsafe } as unknown as Parameters<
        typeof drawNumber
      >[0],
      $queryRawUnsafe,
    };
  }

  it('draws a staff number as CNC-S plus three digits', async () => {
    const { prisma, $queryRawUnsafe } = fakePrisma(1n);

    await expect(drawNumber(prisma, 'staff')).resolves.toBe('CNC-S001');
    expect($queryRawUnsafe).toHaveBeenCalledWith(
      "SELECT nextval('staff_no_seq') AS next",
    );
  });

  it('draws a member number as CNC- plus six digits', async () => {
    const { prisma } = fakePrisma(42n);

    await expect(drawNumber(prisma, 'customer')).resolves.toBe('CNC-000042');
  });

  it('draws a Bar order number from the Bar sequence', async () => {
    const { prisma, $queryRawUnsafe } = fakePrisma(44n);

    await expect(drawNumber(prisma, 'orderBar')).resolves.toBe('CNCB-000044');
    expect($queryRawUnsafe).toHaveBeenCalledWith(
      "SELECT nextval('order_bar_no_seq') AS next",
    );
  });
});
