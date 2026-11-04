import { SETTINGS } from '../prisma/seed-data/reference';
import type { CncPrismaService } from '../src/prisma/cnc-prisma.service';

/**
 * The settings row a seeded database holds, created with the seed's values
 * if this database was never seeded (a fresh CI database); never changed if
 * present.
 *
 * Spelled from `SETTINGS`, not left to the column defaults: since CS B2 the
 * seed starts the receipt paper at 58 mm while the column default stays
 * 80 mm (no schema change). A suite that created the row from the defaults
 * on a fresh database would leave it at 80 mm, and the seed suite, which
 * holds the row to `SETTINGS`, would then fail or pass by the order the
 * suites happened to run in.
 */
export async function createSeededSettingsIfMissing(
  prisma: CncPrismaService,
): Promise<void> {
  await prisma.settings.createMany({
    data: [{ singleton: true, ...SETTINGS }],
    skipDuplicates: true,
  });
}
