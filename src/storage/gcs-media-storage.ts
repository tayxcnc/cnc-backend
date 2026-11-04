import { Injectable, Logger } from '@nestjs/common';
import { Storage } from '@google-cloud/storage';
import { CncConfigService } from '../config/cnc.config';
import {
  DEFAULT_SIGNED_URL_TTL_MS,
  isObjectNotFound,
  MediaStorage,
  parseGsUri,
  type SignedUrl,
  type StoredObject,
} from './media-storage';

/**
 * The type a read answers with when the object carries none. Everything
 * stored here is saved with its type (`PhotoStore` passes the format it
 * read from the bytes), so this is a defensive fallback, not a path any
 * photo takes.
 */
const UNKNOWN_CONTENT_TYPE = 'application/octet-stream';

/**
 * `MediaStorage` on Google Cloud Storage: TAY's `TayStorageService`, copied
 * and given CNC's bucket (`CNC_GCS_BUCKET`, read through
 * `CncConfigService`).
 *
 * ## Credentials
 *
 * Application Default Credentials: on Cloud Run the CNC runtime service
 * account, locally whatever `gcloud auth application-default login` left.
 * No key file is read, and none should ever be added (org policy forbids
 * creating them).
 *
 * **Signing needs one permission beyond object access.** With ADC and no
 * private key, the client signs through the IAM `signBlob` API, so the
 * runtime account needs `roles/iam.serviceAccountTokenCreator` on itself.
 * Without it uploads succeed and every download link fails, which looks like
 * a bug here and is not (see *Infrastructure* in the conventions).
 *
 * ## One client, made on first use
 *
 * The `Storage` client holds a connection pool and refreshes credentials on
 * its own schedule, so it is built once. It is built lazily, on the first
 * upload, read or signature, so booting the service (and every health check)
 * never depends on Google credentials being present.
 */
@Injectable()
export class GcsMediaStorage extends MediaStorage {
  private readonly logger = new Logger(GcsMediaStorage.name);
  private client: Storage | undefined;

  constructor(private readonly config: CncConfigService) {
    super();
  }

  /**
   * `resumable: false`: everything stored here is a resized photo of a few
   * hundred kilobytes at most, and a resumable session is an extra round
   * trip that buys nothing below a few megabytes.
   */
  async save(
    objectName: string,
    body: Buffer,
    contentType: string,
  ): Promise<string> {
    const bucket = this.config.gcsBucket;

    await this.storage()
      .bucket(bucket)
      .file(objectName)
      .save(body, { resumable: false, contentType });

    this.logger.log(`Stored gs://${bucket}/${objectName}.`);

    return `gs://${bucket}/${objectName}`;
  }

  /**
   * The bucket comes from the URI, not from configuration, so an object
   * written before a bucket change still resolves.
   */
  async signedUrl(
    gsUri: string,
    ttlMs: number = DEFAULT_SIGNED_URL_TTL_MS,
  ): Promise<SignedUrl> {
    const { bucket, objectName } = parseGsUri(gsUri);
    const expiresAt = new Date(Date.now() + ttlMs);

    const [url] = await this.storage()
      .bucket(bucket)
      .file(objectName)
      .getSignedUrl({ version: 'v4', action: 'read', expires: expiresAt });

    return { url, expiresAt };
  }

  /**
   * The metadata (for the stored content type) and the bytes are asked for
   * together: a staff photo is a few tens of kilobytes, so the whole object
   * is read into memory rather than streamed, and two parallel calls cost
   * one round trip. A 404 from either, including an object deleted between
   * the two, answers null. The bucket comes from the URI, as for
   * `signedUrl`.
   */
  async read(gsUri: string): Promise<StoredObject | null> {
    const { bucket, objectName } = parseGsUri(gsUri);
    const file = this.storage().bucket(bucket).file(objectName);

    try {
      const [[metadata], [body]] = await Promise.all([
        file.getMetadata(),
        file.download(),
      ]);

      return {
        body,
        contentType: metadata.contentType ?? UNKNOWN_CONTENT_TYPE,
      };
    } catch (error: unknown) {
      if (isObjectNotFound(error)) return null;

      throw error;
    }
  }

  /**
   * `ignoreNotFound`: every caller removes an object it is replacing or
   * abandoning, and in both cases "not there" is the state asked for.
   */
  async remove(gsUri: string): Promise<void> {
    const { bucket, objectName } = parseGsUri(gsUri);

    await this.storage()
      .bucket(bucket)
      .file(objectName)
      .delete({ ignoreNotFound: true });

    this.logger.log(`Deleted gs://${bucket}/${objectName}.`);
  }

  private storage(): Storage {
    this.client ??= new Storage();

    return this.client;
  }
}
