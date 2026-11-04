import type { PrismaClient } from '../../generated/cnc-client';
import type { PhotoStore } from '../images/photo-store.service';

/** The one table the backfill reads and writes. */
type ThumbsClient = Pick<PrismaClient, 'menuItem'>;

/** What one run did, by dish slug. */
export interface ThumbsBackfillReport {
  /** Dishes that got a thumbnail. */
  made: string[];
  /** Dishes whose photo changed while the run made its thumbnail. */
  skipped: string[];
  /** Dishes whose photo could not be read or thumbnailed; tried next run. */
  failed: string[];
}

/**
 * Make the thumbnail of every menu photo stored before thumbnails existed
 * (B2): each dish with a photo and no `photoThumb`, one at a time, through
 * `PhotoStore` like an upload. `npm run media:backfill-thumbs` runs it.
 *
 * - **Safe to run twice.** A dish that has its thumbnail is not selected
 *   again, so a second run finds nothing to do.
 * - **Never over a newer photo.** The thumbnail is recorded only while the
 *   dish still has the photo it was made from and still has no thumbnail
 *   (one conditional update). If a manager replaced or removed the photo
 *   meanwhile, the upload wrote its own thumbnail, so this one is deleted
 *   and the dish is reported as skipped.
 * - **No version move and no audit row.** The thumbnail is derived from the
 *   photo and no screen edits it, so a staff form open on the dish still
 *   saves; the audit log records what people did.
 * - **One failure does not stop the run.** A photo that cannot be read is
 *   reported and left for the next run.
 */
export async function backfillMenuThumbs(
  prisma: ThumbsClient,
  photos: PhotoStore,
  log: (line: string) => void = () => undefined,
): Promise<ThumbsBackfillReport> {
  const report: ThumbsBackfillReport = { made: [], skipped: [], failed: [] };
  const items = await prisma.menuItem.findMany({
    where: { photo: { not: null }, photoThumb: null },
    orderBy: { slug: 'asc' },
    select: { id: true, slug: true, photo: true },
  });

  for (const item of items) {
    // Selected with a photo; narrowed for the compiler.
    if (item.photo === null) continue;

    let thumb: string;

    try {
      thumb = await photos.storeMenuThumbFor(item.id, item.photo);
    } catch (error: unknown) {
      report.failed.push(item.slug);
      log(
        `${item.slug}: no thumbnail made (${error instanceof Error ? error.message : String(error)}).`,
      );
      continue;
    }

    const { count } = await prisma.menuItem.updateMany({
      where: { id: item.id, photo: item.photo, photoThumb: null },
      data: { photoThumb: thumb },
    });

    if (count === 1) {
      report.made.push(item.slug);
      log(`${item.slug}: thumbnail made.`);
    } else {
      await photos.removeQuietly(thumb);
      report.skipped.push(item.slug);
      log(`${item.slug}: the photo changed meanwhile; left as it is.`);
    }
  }

  return report;
}
