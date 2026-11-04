import { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types';
import { seedData } from '../prisma/data-seed';
import { ImageResizerService } from '../src/images/image-resizer.service';
import { PhotoStore } from '../src/images/photo-store.service';
import { backfillMenuThumbs } from '../src/menu/menu-thumbs-backfill';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { MediaStorage } from '../src/storage/media-storage';
import { createTestApp } from './create-test-app';
import { FAKE_BUCKET, FakeMediaStorage } from './fake-media-storage';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { testImage } from './test-images';

interface MenuBody {
  categories: { items: { slug: string; thumbUrl: string | null }[] }[];
}

/**
 * The menu thumbnail backfill (B2, `npm run media:backfill-thumbs`) against
 * the real tables and the fake bucket: photos stored before thumbnails get
 * one each, once; a photo that cannot be read is reported and retried; a
 * photo replaced while the run works is left alone.
 *
 * On a database of its own (`createIsolatedDatabase`) seeded with the real
 * menu, because the backfill reads every dish with a photo and no
 * thumbnail, and it gives seeded dishes photos.
 */
describe('menu thumbnail backfill (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let storage: FakeMediaStorage;
  let photos: PhotoStore;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    storage = app.get<MediaStorage, FakeMediaStorage>(MediaStorage, {
      strict: false,
    });
    photos = app.get(PhotoStore, { strict: false });

    await seedData(prisma);
  }, 120_000);

  afterAll(async () => {
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const dishes = (skip: number, take: number) =>
    prisma.menuItem.findMany({
      where: { active: true, showOnline: true },
      orderBy: { slug: 'asc' },
      skip,
      take,
    });
  const thumbsOf = (ids: string[]) =>
    prisma.menuItem.findMany({
      where: { id: { in: ids } },
      orderBy: { slug: 'asc' },
      select: { slug: true, photoThumb: true, version: true },
    });

  it('makes each missing thumbnail once, from the stored photo, and the menu then carries it', async () => {
    const [a, b, c] = await dishes(0, 3);
    const photoA = await photos.store('menu', a.id, {
      buffer: await testImage(1600, 900),
    });
    const photoB = await photos.store('menu', b.id, {
      buffer: await testImage(500, 700, 'png'),
    });

    await prisma.menuItem.update({
      where: { id: a.id },
      data: { photo: photoA },
    });
    await prisma.menuItem.update({
      where: { id: b.id },
      data: { photo: photoB },
    });
    // A row whose object is not in the bucket.
    await prisma.menuItem.update({
      where: { id: c.id },
      data: { photo: `gs://${FAKE_BUCKET}/menu/${c.id}/photo-gone.jpg` },
    });
    const before = await thumbsOf([a.id, b.id, c.id]);

    const report = await backfillMenuThumbs(prisma, photos);

    expect(report).toEqual({
      made: [a.slug, b.slug],
      skipped: [],
      failed: [c.slug],
    });

    const after = await thumbsOf([a.id, b.id, c.id]);
    const [thumbA, thumbB] = [after[0].photoThumb!, after[1].photoThumb!];
    const [metaA, metaB] = await Promise.all(
      [thumbA, thumbB].map((uri) =>
        sharp(storage.objectAt(uri)?.body).metadata(),
      ),
    );

    expect(thumbA).toMatch(
      new RegExp(`/menu/${a.id}/thumb-[0-9a-f-]{36}\\.webp$`),
    );
    expect([metaA.width, metaA.height, metaA.format]).toEqual([
      240,
      135,
      'webp',
    ]);
    expect([metaB.width, metaB.height, metaB.format]).toEqual([
      171,
      240,
      'webp',
    ]);
    expect(after[2].photoThumb).toBeNull();
    // No version move: a staff form open on the dish still saves.
    expect(after.map((row) => row.version)).toEqual(
      before.map((row) => row.version),
    );

    // Run again: nothing left to make, the failure retried and reported.
    const objects = storage.objects.size;

    expect(await backfillMenuThumbs(prisma, photos)).toEqual({
      made: [],
      skipped: [],
      failed: [c.slug],
    });
    expect(await thumbsOf([a.id, b.id, c.id])).toEqual(after);
    expect(storage.objects.size).toBe(objects);

    const menu = (await request(app.getHttpServer()).get('/api/v1/menu'))
      .body as MenuBody;
    const shown = menu.categories
      .flatMap((category) => category.items)
      .find((item) => item.slug === a.slug);

    expect(shown?.thumbUrl).toContain(thumbA.replace(`gs://`, ''));
  });

  it('leaves a dish whose photo was replaced while the run worked, and deletes the thumbnail it made', async () => {
    const [d] = await dishes(3, 1);
    const old = await photos.store('menu', d.id, {
      buffer: await testImage(900, 600),
    });
    const replaced = {
      photo: `gs://${FAKE_BUCKET}/menu/${d.id}/photo-new.jpg`,
      photoThumb: `gs://${FAKE_BUCKET}/menu/${d.id}/thumb-new.webp`,
    };

    await prisma.menuItem.update({ where: { id: d.id }, data: { photo: old } });

    // A manager's upload lands between the thumbnail and the update.
    const made: string[] = [];
    class RacingStore extends PhotoStore {
      async storeMenuThumbFor(itemId: string, gsUri: string): Promise<string> {
        const thumb = await super.storeMenuThumbFor(itemId, gsUri);

        made.push(thumb);
        await prisma.menuItem.update({ where: { id: d.id }, data: replaced });

        return thumb;
      }
    }

    const report = await backfillMenuThumbs(
      prisma,
      new RacingStore(storage, new ImageResizerService()),
    );

    expect(report.skipped).toEqual([d.slug]);
    expect(report.made).not.toContain(d.slug);
    expect(made).toHaveLength(1);
    expect(storage.objectAt(made[0])).toBeUndefined();
    expect(
      await prisma.menuItem.findUniqueOrThrow({
        where: { id: d.id },
        select: { photo: true, photoThumb: true },
      }),
    ).toEqual(replaced);
  });
});
