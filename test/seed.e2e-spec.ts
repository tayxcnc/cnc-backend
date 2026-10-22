import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { Prisma } from '../generated/cnc-client';
import {
  type DataSeedReport,
  seedData,
  UnpairedBarItemsError,
} from '../prisma/data-seed';
import { buildMenuSeed } from '../prisma/menu-seed';
import { OwnerSeedRefusal, seedOwnerInTransaction } from '../prisma/owner-seed';
import { BUSINESS, SETTINGS, VENUES } from '../prisma/seed-data/reference';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { CncConfigService } from '../src/config/cnc.config';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp } from './create-test-app';
import { lockSharedRows } from './shared-rows-lock';

/**
 * The seeds against Postgres (C3-2): the reference data and menu land as the
 * plan counts them, a re-run changes nothing, an unpaired Bar item rolls the
 * run back, and the Owner seed creates the first Owner once.
 *
 * The test database keeps its rows between runs, so the first `seedData`
 * here may create everything (a fresh CI database) or nothing (a local
 * database seeded before). The assertions hold either way: they read what is
 * there, and they hold the second run to creating nothing and changing
 * nothing.
 *
 * The Owner tests run inside transactions that are rolled back, demoting any
 * existing Owner inside the transaction only, so they see a database with no
 * Owner and leave no account behind.
 */
describe('seeds (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  const menu = buildMenuSeed();
  const itemSlugs = menu.menuItems.map((item) => item.slug);
  const venueSlugs = VENUES.map((venue) => venue.slug);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Run `work` in a transaction that is always rolled back.
   *
   * REPEATABLE READ, so the transaction reads one snapshot taken at its
   * first statement: suites running beside this one create and commit
   * Owner accounts of their own, and under READ COMMITTED one committed
   * between `withoutOwners` and the seed's count made the seed answer
   * "exists" for an Owner this test never saw.
   */
  async function inRolledBack(
    work: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    const ROLLBACK = new Error('rollback');

    await expect(
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
          await work(tx);
          throw ROLLBACK;
        },
        {
          timeout: 30_000,
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        },
      ),
    ).rejects.toBe(ROLLBACK);
  }

  describe('reference data and menu', () => {
    let first: DataSeedReport;
    let second: DataSeedReport;
    let before: unknown;

    /** Every seeded row's identity, version and last write. */
    async function snapshot() {
      const stamp = { id: true, updatedAt: true } as const;
      const versioned = { ...stamp, version: true } as const;

      return {
        settings: await prisma.settings.findMany({ select: versioned }),
        business: await prisma.business.findMany({ select: versioned }),
        venues: await prisma.venue.findMany({
          where: { slug: { in: venueSlugs } },
          select: stamp,
          orderBy: { slug: 'asc' },
        }),
        tables: await prisma.diningTable.findMany({
          where: { venue: { slug: { in: venueSlugs } } },
          select: stamp,
          orderBy: { id: 'asc' },
        }),
        menuItems: await prisma.menuItem.findMany({
          where: { slug: { in: itemSlugs } },
          select: versioned,
          orderBy: { slug: 'asc' },
        }),
        stockItems: await prisma.stockItem.findMany({
          where: { menuItem: { slug: { in: itemSlugs } } },
          select: versioned,
          orderBy: { id: 'asc' },
        }),
      };
    }

    // The settings suite saves the settings, business and hours rows
    // through their routes; holding the shared-rows lock for this block
    // keeps those saves from moving a version between the snapshots.
    let unlockSharedRows: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      unlockSharedRows = await lockSharedRows(
        app.get(CncConfigService).databaseUrl,
      );
      first = await seedData(prisma);
      before = await snapshot();
      second = await seedData(prisma);
    });

    afterAll(async () => {
      await unlockSharedRows?.();
    });

    it('accounts for every row on each run', () => {
      const totals = {
        settings: 1,
        business: 1,
        venues: 2,
        tables: 23,
        menuCategories: 12,
        staffCategories: 25,
        menuItems: 166,
        barStockItems: 87,
      };

      for (const [key, total] of Object.entries(totals)) {
        const { created, present } = first[key as keyof typeof totals];

        expect(created + present).toBe(total);
      }
    });

    it('creates nothing on a re-run', () => {
      expect(second).toEqual({
        settings: { created: 0, present: 1 },
        business: { created: 0, present: 1 },
        venues: { created: 0, present: 2 },
        tables: { created: 0, present: 23 },
        menuCategories: { created: 0, present: 12 },
        staffCategories: { created: 0, present: 25 },
        menuItems: { created: 0, present: 166 },
        barStockItems: { created: 0, present: 87 },
        openingHoursDays: 7,
      });
    });

    it('changes no row on a re-run: no version moves and no write is stamped', async () => {
      expect(await snapshot()).toEqual(before);
    });

    it("leaves one settings row holding Q7's values", async () => {
      const rows = await prisma.settings.findMany();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ singleton: true, ...SETTINGS });
    });

    it('leaves one business row with CNC’s details', async () => {
      const rows = await prisma.business.findMany();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ...BUSINESS,
        addressLines: [...BUSINESS.addressLines],
      });
    });

    it('seeds two rooms with 23 tables and 58 places', async () => {
      const venues = await prisma.venue.findMany({
        where: { slug: { in: venueSlugs } },
        include: { tables: true },
        orderBy: { sort: 'asc' },
      });

      expect(venues.map((venue) => [venue.slug, venue.bigParty])).toEqual([
        ['dining', 4],
        ['lounge', 5],
      ]);

      const tables = venues.flatMap((venue) => venue.tables);

      expect(tables).toHaveLength(23);
      expect(tables.reduce((sum, table) => sum + table.capacity, 0)).toBe(58);
    });

    it('seeds the 12 customer categories and the 25 staff categories', async () => {
      const categories = await prisma.menuCategory.findMany({
        where: {
          slug: { in: menu.menuCategories.map((category) => category.slug) },
        },
        include: { _count: { select: { menuItems: true } } },
      });
      const staffCategories = await prisma.staffCategory.findMany({
        where: {
          name: { in: menu.staffCategories.map((category) => category.name) },
        },
        include: { menuCategory: { select: { slug: true } } },
      });

      expect(categories).toHaveLength(12);
      expect(staffCategories).toHaveLength(25);
      expect(
        staffCategories.find((category) => category.name === 'Pizza')
          ?.menuCategory.slug,
      ).toBe('street-and-social');
    });

    it('seeds the 166 items as built: 79 Restaurant, 87 Bar, 11 with a choice, prices in kobo', async () => {
      const items = await prisma.menuItem.findMany({
        where: { slug: { in: itemSlugs } },
        include: {
          menuCategory: { select: { slug: true } },
          staffCategory: { select: { name: true } },
        },
      });

      expect(items).toHaveLength(166);
      expect(
        items.filter((item) => item.department === 'RESTAURANT'),
      ).toHaveLength(79);
      expect(items.filter((item) => item.department === 'BAR')).toHaveLength(
        87,
      );
      expect(
        items.filter((item) => item.choiceOptions.length > 0),
      ).toHaveLength(11);

      const stored = new Map(items.map((item) => [item.slug, item]));

      for (const built of menu.menuItems) {
        const item = stored.get(built.slug);

        expect(item).toMatchObject({
          legacyStaffId: built.legacyStaffId,
          name: built.name,
          priceKobo: built.priceKobo,
          department: built.department,
          choiceLabel: built.choiceLabel,
          choiceOptions: built.choiceOptions,
          menuCategory: { slug: built.menuCategorySlug },
          staffCategory: { name: built.staffCategoryName },
        });
      }
    });

    it('pairs each Bar item with exactly one Bar stock item, and no Restaurant item with any', async () => {
      const items = await prisma.menuItem.findMany({
        where: { slug: { in: itemSlugs } },
        include: { stockItem: true },
      });

      const bar = items.filter((item) => item.department === 'BAR');
      const restaurant = items.filter(
        (item) => item.department === 'RESTAURANT',
      );

      expect(bar).toHaveLength(87);

      for (const item of bar) {
        expect(item.stockItem).toMatchObject({
          name: item.name,
          kind: 'BAR',
          unit: 'serving',
          pack: 'batch',
          factor: 12,
          minimum: 12,
          active: true,
        });
      }

      expect(restaurant.every((item) => item.stockItem === null)).toBe(true);
    });

    it('finds the week of opening hours the migration seeded', () => {
      expect(first.openingHoursDays).toBe(7);
    });
  });

  describe('an unpaired Bar item', () => {
    it('rolls the whole run back when a stock item already holds the name', async () => {
      const name = `Probe Drink ${randomUUID()}`;
      const slug = `probe-drink-${randomUUID()}`;

      // A Kitchen item holding the name (in another case), so the paired
      // insert is skipped on the name index.
      await prisma.stockItem.create({
        data: {
          name: name.toLowerCase(),
          kind: 'KITCHEN',
          unit: 'portion',
          pack: 'tray',
          factor: 10,
          minimum: 0,
        },
      });

      const withProbe = buildMenuSeed();
      withProbe.menuItems.push({
        ...withProbe.menuItems.find((item) => item.department === 'BAR')!,
        slug,
        legacyStaffId: `probe-${randomUUID()}`,
        name,
      });
      withProbe.barStockItems.push({
        ...withProbe.barStockItems[0],
        menuItemSlug: slug,
        name,
      });

      const failure = await seedData(prisma, withProbe).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(UnpairedBarItemsError);
      expect((failure as UnpairedBarItemsError).slugs).toEqual([slug]);
      expect(await prisma.menuItem.count({ where: { slug } })).toBe(0);
    });
  });

  describe('the first Owner', () => {
    const NOW = new Date('2026-10-20T23:30:00.000Z');

    /** Demote every Owner, inside the caller's rolled-back transaction. */
    async function withoutOwners(tx: Prisma.TransactionClient): Promise<void> {
      await tx.staff.updateMany({
        where: { role: 'OWNER' },
        data: { role: 'MANAGER' },
      });
    }

    it('creates an active Owner with a temporary argon2id password and a QR token', async () => {
      await inRolledBack(async (tx) => {
        await withoutOwners(tx);

        const email = `owner-${randomUUID()}@cnc.test`;
        const password = `temporary-${randomUUID()}`;
        const result = await seedOwnerInTransaction(
          tx,
          { email, password, name: 'Probe Owner' },
          await hashPassword(password),
          NOW,
        );

        expect(result).toEqual({
          outcome: 'created',
          staffNo: expect.stringMatching(/^CNC-S\d{3,}$/) as unknown,
          email,
        });

        const owner = await tx.staff.findUniqueOrThrow({ where: { email } });

        expect(owner).toMatchObject({
          staffNo: result.staffNo,
          name: 'Probe Owner',
          role: 'OWNER',
          isActive: true,
          mustChangePassword: true,
          version: 0,
          photo: null,
        });
        expect(owner.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        // 23:30 UTC is 00:30 the next day in Jos.
        expect(owner.joinedOn.toISOString()).toBe('2026-10-21T00:00:00.000Z');
        expect(owner.passwordHash.startsWith('$argon2id$')).toBe(true);
        await expect(
          verifyPassword(owner.passwordHash, password),
        ).resolves.toBe(true);
      });
    });

    it('does nothing once an Owner exists: no second Owner, no new password', async () => {
      await inRolledBack(async (tx) => {
        await withoutOwners(tx);

        const email = `owner-${randomUUID()}@cnc.test`;
        const password = `temporary-${randomUUID()}`;
        const created = await seedOwnerInTransaction(
          tx,
          { email, password, name: 'Probe Owner' },
          await hashPassword(password),
          NOW,
        );
        const stored = await tx.staff.findUniqueOrThrow({ where: { email } });

        for (const rerun of [email, `other-${randomUUID()}@cnc.test`]) {
          const again = await seedOwnerInTransaction(
            tx,
            { email: rerun, password: 'a-different-password', name: 'Again' },
            await hashPassword('a-different-password'),
            new Date(),
          );

          expect(again).toEqual({
            outcome: 'exists',
            staffNo: created.staffNo,
            email,
          });
        }

        expect(await tx.staff.findUniqueOrThrow({ where: { email } })).toEqual(
          stored,
        );
        expect(await tx.staff.count({ where: { role: 'OWNER' } })).toBe(1);
      });
    });

    it('refuses an email that belongs to another staff member rather than promote them', async () => {
      await inRolledBack(async (tx) => {
        await withoutOwners(tx);

        const email = `cashier-${randomUUID()}@cnc.test`;
        await tx.staff.create({
          data: {
            staffNo: `CNC-STEST-${randomUUID()}`,
            name: 'Probe Cashier',
            email,
            role: 'CASHIER',
            passwordHash: 'not-a-real-hash',
            qrToken: randomUUID(),
            joinedOn: new Date('2026-10-20T00:00:00.000Z'),
          },
        });

        await expect(
          seedOwnerInTransaction(
            tx,
            { email, password: 'a-long-password', name: 'Probe' },
            'not-a-real-hash',
            NOW,
          ),
        ).rejects.toBeInstanceOf(OwnerSeedRefusal);
        expect(
          await tx.staff.findUniqueOrThrow({
            where: { email },
            select: { role: true },
          }),
        ).toEqual({ role: 'CASHIER' });
        expect(await tx.staff.count({ where: { role: 'OWNER' } })).toBe(0);
      });
    });
  });
});
