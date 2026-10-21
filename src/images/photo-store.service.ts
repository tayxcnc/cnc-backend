import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { MediaStorage } from '../storage/media-storage';
import { ImageResizerService, type PhotoKind } from './image-resizer.service';
import { readUploadedImage, type UploadedImageFile } from './uploaded-image';

/**
 * Staff and menu photographs (A17): judged by their bytes, resized, stored
 * privately as a `gs://` URI, and signed per read. TAY's
 * `MemberPhotoStorageService` and the upload half of its `MemberService`,
 * copied into one service both CNC uploads share.
 *
 * ## The order a replacement runs in
 *
 * 1. `store` writes the new object, **before** the command's transaction
 *    opens: an upload to Google is a network call, and a transaction should
 *    not hold a row lock across one.
 * 2. The command points the row at the new URI inside its transaction.
 * 3. After the commit, the old object is removed with `removeQuietly`; if
 *    the transaction failed, the new one is, so a refused upload leaves
 *    nothing behind.
 *
 * Deleting the old object first and then failing the update would leave a
 * row pointing at nothing, a broken photo where there was a working one. In
 * this order the worst case is an orphaned object nobody references.
 */
@Injectable()
export class PhotoStore {
  private readonly logger = new Logger(PhotoStore.name);

  constructor(
    private readonly storage: MediaStorage,
    private readonly resizer: ImageResizerService,
  ) {}

  /**
   * Check, resize and write an upload for one owner (a staff member, a menu
   * item); returns the `gs://` URI to record. Refuses with 400, 413 or 415
   * (`readUploadedImage`) before anything is written.
   *
   * **A fresh random name per upload** (`staff/<id>/photo-<uuid>.jpg`), not
   * a stable one: a stable name would be overwritten in place while browsers
   * and proxies kept serving the old photo from an unchanged URL, and the
   * row would name a half-written file while the upload ran. Grouped by
   * owner, so everything stored for one person is one prefix.
   */
  async store(
    kind: PhotoKind,
    ownerId: string,
    file: UploadedImageFile | undefined,
  ): Promise<string> {
    const { bytes, image } = readUploadedImage(file);
    const stored = await this.resizer.resize(kind, bytes, image);
    const objectName = `${kind}/${ownerId}/photo-${randomUUID()}.${image.format.extension}`;

    return this.storage.save(objectName, stored, image.format.contentType);
  }

  /**
   * The stored URI as a link a browser can load, or null: the one place a
   * photo is signed on the way out, so no response returns a `gs://` URI
   * (TAY's digital ID card once did, and showed a broken image).
   *
   * A signing failure degrades to null rather than failing the request: a
   * screen should not be unavailable because a photograph could not be
   * signed.
   */
  async signedUrlOrNull(gsUri: string | null): Promise<string | null> {
    if (gsUri === null) return null;

    try {
      const { url } = await this.storage.signedUrl(gsUri);

      return url;
    } catch (error: unknown) {
      this.logger.error(
        `Could not sign a link for ${gsUri}; answering without the photo.`,
        error instanceof Error ? error.stack : String(error),
      );

      return null;
    }
  }

  /**
   * Remove an object nothing points at any more (the photo a replacement or
   * removal left, or a new one whose command failed). A failure is logged,
   * never thrown: the command has already succeeded or failed on its own
   * terms, and an orphaned object costs a fraction of a penny.
   */
  async removeQuietly(gsUri: string | null): Promise<void> {
    if (gsUri === null) return;

    try {
      await this.storage.remove(gsUri);
    } catch (error: unknown) {
      this.logger.error(
        `Could not delete ${gsUri}. Nothing points at it; it is an orphaned ` +
          'object, not a lost photo.',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
