import type { CncConfigService } from '../config/cnc.config';
import { GcsMediaStorage } from './gcs-media-storage';

/**
 * `read` against a stand-in for the Cloud Storage client: no test reaches a
 * real bucket or needs Google credentials. The e2e suites use
 * `FakeMediaStorage`; this proves what the real binding does with the
 * client's answers, which the fake cannot.
 *
 * The `mock` prefix lets the hoisted `jest.mock` factory refer to them.
 */
const mockOpened: string[] = [];
const mockFile = {
  getMetadata: jest.fn(),
  download: jest.fn(),
};

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({
    bucket: (name: string) => ({
      file: (objectName: string) => {
        mockOpened.push(`${name}/${objectName}`);

        return mockFile;
      },
    }),
  })),
}));

describe('GcsMediaStorage.read', () => {
  const storage = new GcsMediaStorage({
    gcsBucket: 'configured-bucket',
  } as CncConfigService);

  beforeEach(() => {
    mockOpened.length = 0;
    mockFile.getMetadata.mockReset();
    mockFile.download.mockReset();
  });

  /** The client's error for a missing object: an ApiError with code 404. */
  const notFound = () =>
    Object.assign(new Error('No such object'), { code: 404 });

  it('answers the bytes and the stored type, from the bucket the URI names', async () => {
    const body = Buffer.from('jpeg bytes');
    mockFile.getMetadata.mockResolvedValue([{ contentType: 'image/jpeg' }]);
    mockFile.download.mockResolvedValue([body]);

    await expect(
      storage.read('gs://older-bucket/staff/s1/photo-1.jpg'),
    ).resolves.toEqual({ body, contentType: 'image/jpeg' });
    expect(mockOpened).toEqual(['older-bucket/staff/s1/photo-1.jpg']);
  });

  it('falls back to a generic type when the object carries none', async () => {
    mockFile.getMetadata.mockResolvedValue([{}]);
    mockFile.download.mockResolvedValue([Buffer.from('x')]);

    await expect(storage.read('gs://b/o.jpg')).resolves.toMatchObject({
      contentType: 'application/octet-stream',
    });
  });

  it('answers null when the object is not there, whichever call finds out', async () => {
    mockFile.getMetadata.mockRejectedValue(notFound());
    mockFile.download.mockResolvedValue([Buffer.from('x')]);
    await expect(storage.read('gs://b/o.jpg')).resolves.toBeNull();

    mockFile.getMetadata.mockResolvedValue([{ contentType: 'image/jpeg' }]);
    mockFile.download.mockRejectedValue(notFound());
    await expect(storage.read('gs://b/o.jpg')).resolves.toBeNull();
  });

  it('throws any other failure, so a broken bucket is never read as no photo', async () => {
    const denied = Object.assign(new Error('Forbidden'), { code: 403 });
    mockFile.getMetadata.mockRejectedValue(denied);
    mockFile.download.mockResolvedValue([Buffer.from('x')]);

    await expect(storage.read('gs://b/o.jpg')).rejects.toBe(denied);
  });

  it('refuses a value that is not a gs:// URI before calling the client', async () => {
    await expect(storage.read('https://example.test/o.jpg')).rejects.toThrow(
      'Not a gs:// URI',
    );
    expect(mockOpened).toEqual([]);
  });
});
