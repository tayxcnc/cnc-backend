import {
  DEFAULT_SIGNED_URL_TTL_MS,
  MediaStorage,
  parseGsUri,
  type SignedUrl,
} from '../src/storage/media-storage';

/** The bucket name the fake reports; no real bucket is ever named. */
export const FAKE_BUCKET = 'cnc-test-media';

/** One stored object. */
export interface FakeObject {
  body: Buffer;
  contentType: string;
}

/**
 * `MediaStorage` in memory, for every e2e suite (through
 * `createTestApp`) and the unit specs. No test writes to a real bucket or
 * needs Google credentials.
 *
 * Objects are kept by name so a test can read back exactly what was stored
 * (the resized bytes) and see what was removed. Signed URLs are fake links
 * that name the object and expire like real ones. `failSigning` and
 * `failRemoving` make the next calls throw, for the paths that must survive
 * a storage failure.
 */
export class FakeMediaStorage extends MediaStorage {
  readonly objects = new Map<string, FakeObject>();
  failSigning = false;
  failRemoving = false;

  save(objectName: string, body: Buffer, contentType: string): Promise<string> {
    this.objects.set(objectName, { body, contentType });

    return Promise.resolve(`gs://${FAKE_BUCKET}/${objectName}`);
  }

  signedUrl(
    gsUri: string,
    ttlMs: number = DEFAULT_SIGNED_URL_TTL_MS,
  ): Promise<SignedUrl> {
    if (this.failSigning) {
      return Promise.reject(new Error('Fake signing failure.'));
    }

    const { bucket, objectName } = parseGsUri(gsUri);
    const expiresAt = new Date(Date.now() + ttlMs);

    return Promise.resolve({
      url: `https://storage.test/${bucket}/${objectName}?X-Goog-Signature=fake`,
      expiresAt,
    });
  }

  remove(gsUri: string): Promise<void> {
    if (this.failRemoving) {
      return Promise.reject(new Error('Fake removal failure.'));
    }

    this.objects.delete(parseGsUri(gsUri).objectName);

    return Promise.resolve();
  }

  /** The stored object a `gs://` URI names, or undefined. */
  objectAt(gsUri: string): FakeObject | undefined {
    return this.objects.get(parseGsUri(gsUri).objectName);
  }
}
