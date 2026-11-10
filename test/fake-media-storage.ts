import {
  DEFAULT_SIGNED_URL_TTL_MS,
  MediaStorage,
  parseGsUri,
  type SignedUrl,
  type StoredObject,
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
 * that name the object and expire like real ones. `read` answers the stored
 * bytes, or null for an object that is not there, as the real binding does
 * for a 404. `failSigning`, `failRemoving` and `failReading` make the next
 * calls throw, for the paths that must survive or report a storage failure.
 */
export class FakeMediaStorage extends MediaStorage {
  readonly objects = new Map<string, FakeObject>();
  failSigning = false;
  failRemoving = false;
  failReading = false;
  signings = 0;

  save(objectName: string, body: Buffer, contentType: string): Promise<string> {
    this.objects.set(objectName, { body, contentType });

    return Promise.resolve(`gs://${FAKE_BUCKET}/${objectName}`);
  }

  /**
   * A fake link that, like a real V4 link, carries its life in seconds
   * (`X-Goog-Expires`) and the moment it was signed (`X-Goog-Date`, here
   * in milliseconds), so a suite can read both from a response. Every
   * call is counted in `signings`.
   */
  signedUrl(
    gsUri: string,
    ttlMs: number = DEFAULT_SIGNED_URL_TTL_MS,
  ): Promise<SignedUrl> {
    if (this.failSigning) {
      return Promise.reject(new Error('Fake signing failure.'));
    }

    this.signings += 1;

    const { bucket, objectName } = parseGsUri(gsUri);
    const signedAt = Date.now();
    const expiresAt = new Date(signedAt + ttlMs);

    return Promise.resolve({
      url:
        `https://storage.test/${bucket}/${objectName}` +
        `?X-Goog-Date=${signedAt}&X-Goog-Expires=${ttlMs / 1000}` +
        '&X-Goog-Signature=fake',
      expiresAt,
    });
  }

  read(gsUri: string): Promise<StoredObject | null> {
    if (this.failReading) {
      return Promise.reject(new Error('Fake read failure.'));
    }

    const stored = this.objectAt(gsUri);

    return Promise.resolve(
      stored === undefined
        ? null
        : { body: stored.body, contentType: stored.contentType },
    );
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
