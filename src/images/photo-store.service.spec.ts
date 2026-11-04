import { Logger, UnsupportedMediaTypeException } from '@nestjs/common';
import sharp from 'sharp';
import { FAKE_BUCKET, FakeMediaStorage } from '../../test/fake-media-storage';
import { ImageResizerService } from './image-resizer.service';
import { PhotoStore } from './photo-store.service';

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
