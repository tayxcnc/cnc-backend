import { Logger, UnsupportedMediaTypeException } from '@nestjs/common';
import sharp from 'sharp';
import { FAKE_BUCKET, FakeMediaStorage } from '../../test/fake-media-storage';
import { PUBLIC_PHOTO_LINK_TTL_MS } from '../common/public-cache';
import { ImageResizerService } from './image-resizer.service';
import {
  PhotoStore,
  PUBLIC_LINK_MEMO_SIZE,
  PUBLIC_LINK_MIN_REMAINING_MS,
} from './photo-store.service';

describe('PhotoStore', () => {
  let storage: FakeMediaStorage;
  let photos: PhotoStore;

  let logged: jest.SpyInstance;

  beforeEach(() => {
    storage = new FakeMediaStorage();
    photos = new PhotoStore(storage, new ImageResizerService());
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    logged.mockRestore();
  });

  const photo = () =>
    sharp({
      create: { width: 900, height: 600, channels: 3, background: '#335577' },
    })
      .jpeg()
      .toBuffer();

  it('stores the resized photo under a fresh name per upload, grouped by owner', async () => {
    const buffer = await photo();

    const first = await photos.store('staff', 'staff-1', { buffer });
    const second = await photos.store('staff', 'staff-1', { buffer });

    expect(first).toMatch(
      new RegExp(
        `^gs://${FAKE_BUCKET}/staff/staff-1/photo-[0-9a-f-]{36}\\.jpg$`,
      ),
    );
    expect(second).not.toBe(first);

    const stored = storage.objectAt(first);
    expect(stored?.contentType).toBe('image/jpeg');
    expect((await sharp(stored?.body).metadata()).width).toBe(320);
  });

  it('writes nothing when the upload is refused', async () => {
    await expect(
      photos.store('menu', 'item-1', { buffer: Buffer.from('not a photo') }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

    expect(storage.objects.size).toBe(0);
  });

  it('signs a stored photo, answers null for none, and null when signing fails', async () => {
    const gsUri = await photos.store('menu', 'item-1', {
      buffer: await photo(),
    });

    await expect(photos.signedUrlOrNull(gsUri)).resolves.toMatch(
      /^https:\/\/storage\.test\//,
    );
    await expect(photos.signedUrlOrNull(null)).resolves.toBeNull();

    storage.failSigning = true;
    await expect(photos.signedUrlOrNull(gsUri)).resolves.toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('stores a menu photo with its 240 pixel WebP thumbnail, each under a fresh name (B2)', async () => {
    const stored = await photos.storeMenuPhoto('item-1', {
      buffer: await photo(),
    });

    expect(stored.photo).toMatch(
      new RegExp(`^gs://${FAKE_BUCKET}/menu/item-1/photo-[0-9a-f-]{36}\\.jpg$`),
    );
    expect(stored.thumb).toMatch(
      new RegExp(
        `^gs://${FAKE_BUCKET}/menu/item-1/thumb-[0-9a-f-]{36}\\.webp$`,
      ),
    );

    const thumb = storage.objectAt(stored.thumb);
    const meta = await sharp(thumb?.body).metadata();

    expect(thumb?.contentType).toBe('image/webp');
    expect([meta.width, meta.height, meta.format]).toEqual([240, 160, 'webp']);
  });

  it('removes the photo when its thumbnail cannot be written, and writes nothing for a refused upload', async () => {
    class ThumbFailingStorage extends FakeMediaStorage {
      save(name: string, body: Buffer, type: string): Promise<string> {
        return name.includes('/thumb-')
          ? Promise.reject(new Error('Fake write failure.'))
          : super.save(name, body, type);
      }
    }
    storage = new ThumbFailingStorage();
    photos = new PhotoStore(storage, new ImageResizerService());

    await expect(
      photos.storeMenuPhoto('item-1', { buffer: await photo() }),
    ).rejects.toThrow('Fake write failure.');
    expect(storage.objects.size).toBe(0);

    await expect(
      photos.storeMenuPhoto('item-1', { buffer: Buffer.from('not a photo') }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    expect(storage.objects.size).toBe(0);
  });

  it('makes a thumbnail for a photo already stored, from its stored bytes', async () => {
    const gsUri = await photos.store('menu', 'item-1', {
      buffer: await photo(),
    });

    const thumb = await photos.storeMenuThumbFor('item-1', gsUri);
    const meta = await sharp(storage.objectAt(thumb)?.body).metadata();

    expect(thumb).toMatch(/\/menu\/item-1\/thumb-[0-9a-f-]{36}\.webp$/);
    expect([meta.width, meta.format]).toEqual([240, 'webp']);
    await expect(
      photos.storeMenuThumbFor('item-1', `gs://${FAKE_BUCKET}/menu/gone.jpg`),
    ).rejects.toThrow();
  });

  describe('public links (B2)', () => {
    const MINUTE = 60 * 1000;
    const start = Date.UTC(2026, 10, 4, 11, 0, 0);
    let now: number;
    let clock: jest.SpyInstance;

    beforeEach(() => {
      now = start;
      clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      clock.mockRestore();
    });

    const lifeOf = (url: string | null) =>
      Number(new URL(url ?? '').searchParams.get('X-Goog-Expires'));

    it('signs for an hour and reuses the link while 45 minutes or more remain', async () => {
      expect(PUBLIC_PHOTO_LINK_TTL_MS).toBe(60 * MINUTE);
      expect(PUBLIC_LINK_MIN_REMAINING_MS).toBe(45 * MINUTE);

      const gsUri = `gs://${FAKE_BUCKET}/menu/item-1/photo-a.jpg`;
      const first = await photos.publicSignedUrlOrNull(gsUri);

      expect(lifeOf(first)).toBe(3600);
      expect(storage.signings).toBe(1);

      now = start + 15 * MINUTE; // exactly 45 minutes left
      await expect(photos.publicSignedUrlOrNull(gsUri)).resolves.toBe(first);
      expect(storage.signings).toBe(1);

      now = start + 15 * MINUTE + 1; // just under 45 minutes left
      const second = await photos.publicSignedUrlOrNull(gsUri);

      expect(second).not.toBe(first);
      expect(lifeOf(second)).toBe(3600);
      expect(storage.signings).toBe(2);

      now += 10 * MINUTE;
      await expect(photos.publicSignedUrlOrNull(gsUri)).resolves.toBe(second);
      expect(storage.signings).toBe(2);
    });

    it('keeps one link per object, answers null for none, and never remembers a failure', async () => {
      const a = `gs://${FAKE_BUCKET}/menu/item-1/photo-a.jpg`;
      const b = `gs://${FAKE_BUCKET}/menu/item-1/thumb-b.webp`;

      const linkA = await photos.publicSignedUrlOrNull(a);
      const linkB = await photos.publicSignedUrlOrNull(b);

      expect(linkA).toMatch(/photo-a\.jpg/);
      expect(linkB).toMatch(/thumb-b\.webp/);
      await expect(photos.publicSignedUrlOrNull(null)).resolves.toBeNull();
      expect(storage.signings).toBe(2);

      const c = `gs://${FAKE_BUCKET}/menu/item-2/photo-c.jpg`;
      storage.failSigning = true;
      await expect(photos.publicSignedUrlOrNull(c)).resolves.toBeNull();
      // Remembered links are still handed out while signing fails.
      await expect(photos.publicSignedUrlOrNull(a)).resolves.toBe(linkA);

      storage.failSigning = false;
      await expect(photos.publicSignedUrlOrNull(c)).resolves.toMatch(
        /photo-c\.jpg/,
      );
      expect(storage.signings).toBe(3);
    });

    it(`remembers at most ${PUBLIC_LINK_MEMO_SIZE} links, dropping the oldest first`, async () => {
      const uri = (n: number) => `gs://${FAKE_BUCKET}/menu/item-${n}/photo.jpg`;

      for (let n = 0; n <= PUBLIC_LINK_MEMO_SIZE; n += 1) {
        await photos.publicSignedUrlOrNull(uri(n));
      }
      expect(storage.signings).toBe(PUBLIC_LINK_MEMO_SIZE + 1);

      // The newest is still remembered; the oldest was dropped.
      await photos.publicSignedUrlOrNull(uri(PUBLIC_LINK_MEMO_SIZE));
      expect(storage.signings).toBe(PUBLIC_LINK_MEMO_SIZE + 1);
      await photos.publicSignedUrlOrNull(uri(0));
      expect(storage.signings).toBe(PUBLIC_LINK_MEMO_SIZE + 2);
    });

    it('leaves signed-in links as they were: ten minutes, signed afresh every time', async () => {
      const gsUri = `gs://${FAKE_BUCKET}/staff/staff-1/photo-a.jpg`;

      await photos.publicSignedUrlOrNull(gsUri);
      const first = await photos.signedUrlOrNull(gsUri);
      now += 1;
      const second = await photos.signedUrlOrNull(gsUri);

      expect(lifeOf(first)).toBe(600);
      expect(lifeOf(second)).toBe(600);
      expect(second).not.toBe(first);
      expect(storage.signings).toBe(3);
    });
  });

  it('reads back the stored bytes and type, null for no photo or a missing object, and throws when the read fails', async () => {
    const gsUri = await photos.store('staff', 'staff-1', {
      buffer: await photo(),
    });
    const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    try {
      await expect(photos.read(gsUri)).resolves.toEqual({
        body: storage.objectAt(gsUri)?.body,
        contentType: 'image/jpeg',
      });
      await expect(photos.read(null)).resolves.toBeNull();
      expect(warned).not.toHaveBeenCalled();

      // Recorded but gone from the bucket: no photo, and a warning that
      // names the row's URI.
      storage.objects.clear();
      await expect(photos.read(gsUri)).resolves.toBeNull();
      expect(warned).toHaveBeenCalledTimes(1);

      // A failing bucket is not "no photo".
      storage.failReading = true;
      await expect(photos.read(gsUri)).rejects.toThrow('Fake read failure.');
    } finally {
      warned.mockRestore();
    }
  });

  it('removes quietly, and never throws when removal fails', async () => {
    const gsUri = await photos.store('menu', 'item-1', {
      buffer: await photo(),
    });

    storage.failRemoving = true;
    await expect(photos.removeQuietly(gsUri)).resolves.toBeUndefined();
    expect(storage.objectAt(gsUri)).toBeDefined();
    expect(logged).toHaveBeenCalledTimes(1);

    storage.failRemoving = false;
    await photos.removeQuietly(gsUri);
    expect(storage.objectAt(gsUri)).toBeUndefined();
    await expect(photos.removeQuietly(null)).resolves.toBeUndefined();
  });
});
