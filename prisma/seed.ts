import { type DataSeedReport, seedData } from './data-seed';
import { createWritingSeedClient } from './seed-client';

/**
 * Seeds CNC's reference data and menu: settings, business details, rooms and
 * tables, categories, the 166 menu items and the 87 paired Bar stock items.
 * No credential: the first Owner is `npm run db:seed:owner`.
 *
 *   npm run db:seed
 *
 * Also Prisma's `seed` key (`prisma.config.ts`), so `npx prisma db seed` and
 * a local `migrate reset` restore a usable menu. Safe to re-run: it inserts
 * only what is missing and never changes a row (`data-seed.ts`).
 *
 * Refuses any database but a local one unless `CNC_SEED_DATA_ALLOW_REMOTE`
 * is exactly `true` for the run (`local-database.ts`).
 */

const LABELS: Record<keyof Omit<DataSeedReport, 'openingHoursDays'>, string> = {
  settings: 'Settings row',
  business: 'Business details',
  venues: 'Rooms',
  tables: 'Tables',
  menuCategories: 'Menu categories',
  staffCategories: 'Staff categories',
  menuItems: 'Menu items',
  barStockItems: 'Paired Bar stock items',
};

async function main(): Promise<void> {
  const prisma = createWritingSeedClient(
    'CNC_SEED_DATA_ALLOW_REMOTE',
    process.env.CNC_SEED_DATA_ALLOW_REMOTE,
  );

  try {
    const report = await seedData(prisma);

    for (const [key, label] of Object.entries(LABELS)) {
      const { created, present } = report[key as keyof typeof LABELS];

      console.log(`${label}: ${created} created, ${present} already there.`);
    }

    console.log(
      `Opening hours: ${report.openingHoursDays} days (seeded by the migration).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // A seed that exits 0 after doing nothing is how a missing menu is found
  // at the till. Fail loudly, with the reason and nothing else.
  console.error('Seeding failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
