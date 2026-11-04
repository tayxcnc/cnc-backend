import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createWritingSeedClient } from '../prisma/seed-client';
import { CncConfigModule } from '../src/config/cnc-config.module';
import { ImagesModule } from '../src/images/images.module';
import { PhotoStore } from '../src/images/photo-store.service';
import { backfillMenuThumbs } from '../src/menu/menu-thumbs-backfill';

/**
 * Makes the 240 pixel thumbnail of every menu photo stored before
 * thumbnails existed (B2, `backfillMenuThumbs`). Run once after the deploy
 * that adds `MenuItem.photoThumb`:
 *
 *   npm run media:backfill-thumbs
 *
 * Reads `CNC_DB_URL` and, through `CncConfigService`, the bucket
 * (`CNC_GCS_BUCKET`) and the boot rules' settings, from the environment and
 * `.env`. The photos are read and the thumbnails written with Application
 * Default Credentials, as the service does. Safe to re-run: a dish that has
 * its thumbnail is not touched again.
 *
 * Refuses any database but a local one unless `CNC_SEED_THUMBS_ALLOW_REMOTE`
 * is exactly `true` for the run (`local-database.ts`).
 */

/** Only the bucket and the config it needs; no HTTP, no other module. */
@Module({ imports: [CncConfigModule, ImagesModule] })
class ThumbsBackfillModule {}

async function main(): Promise<void> {
  const prisma = createWritingSeedClient(
    'CNC_SEED_THUMBS_ALLOW_REMOTE',
    process.env.CNC_SEED_THUMBS_ALLOW_REMOTE,
  );
  const context = await NestFactory.createApplicationContext(
    ThumbsBackfillModule,
    { logger: ['error', 'warn'] },
  );

  try {
    const report = await backfillMenuThumbs(
      prisma,
      context.get(PhotoStore),
      (line) => console.log(line),
    );

    console.log(
      `Thumbnails made: ${report.made.length}. Skipped (photo changed ` +
        `meanwhile): ${report.skipped.length}. Failed: ${report.failed.length}.`,
    );

    if (report.failed.length > 0) {
      console.error('Run it again to retry the failed dishes.');
      process.exitCode = 1;
    }
  } finally {
    await context.close();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('The thumbnail backfill failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
