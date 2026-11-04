import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PUBLIC_PHOTO_LINK_TTL_MS } from '../common/public-cache';
import { MediaStorage, type SignedUrl } from '../storage/media-storage';
import {
  ImageResizerService,
  MENU_THUMB_FORMAT,
  type PhotoKind,
} from './image-resizer.service';
import { readUploadedImage, type UploadedImageFile } from './uploaded-image';

/**
 * A public link is handed out again while at least this much of its life
 * remains: 45 minutes of the hour it is signed for (B2). See
 * `PhotoStore.publicSignedUrlOrNull`.
 */
export const PUBLIC_LINK_MIN_REMAINING_MS = 45 * 60 * 1000;

/**
 * At most this many public links are remembered per instance. The menu
 * needs two per dish with a photo (166 dishes today), and a link is about
 * a kilobyte, so the cap is a megabyte at most, with room for photos that
 * have since been replaced.
 */
export const PUBLIC_LINK_MEMO_SIZE = 1000;

/** What `storeMenuPhoto` wrote: the photo and its thumbnail. */
export interface StoredMenuPhoto {
  photo: string;
  thumb: string;
}

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

  /** Public links by `gs://` URI, oldest first (`publicSignedUrlOrNull`). */
  private readonly publicLinks = new Map<string, SignedUrl>();

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
    return (await this.write(kind, ownerId, file)).gsUri;
  }

  /**
   * A menu photo and its thumbnail (B2), both written before the command's
   * transaction opens, like `store`. The thumbnail is made from the stored
   * photo (`menuThumbnail`) under its own fresh name
   * (`menu/<id>/thumb-<uuid>.webp`). If it cannot be written, the photo
   * just written is removed and the upload fails, so a row never points at
   * a photo without its thumbnail through this path.
   */
  async storeMenuPhoto(
    itemId: string,
    file: UploadedImageFile | undefined,
  ): Promise<StoredMenuPhoto> {
    const photo = await this.write('menu', itemId, file);

    try {
      const thumb = await this.writeMenuThumb(itemId, photo.stored);

      return { photo: photo.gsUri, thumb };
    } catch (error) {
      await this.removeQuietly(photo.gsUri);
      throw error;
    }
  }

  /**
   * A thumbnail for a menu photo stored before thumbnails existed, made
   * from the stored bytes; returns its `gs://` URI. The backfill's one
   * step (`backfillMenuThumbs`).
   */
  async storeMenuThumbFor(itemId: string, photoGsUri: string): Promise<string> {
    return this.writeMenuThumb(itemId, await this.storage.read(photoGsUri));
  }

  /**
   * The stored URI as a link a browser can load, or null: the one place a
   * photo is signed on the way out, so no response returns a `gs://` URI
   * (TAY's digital ID card once did, and showed a broken image).
   *
   * A signing failure degrades to null rather than failing the request: a
   * screen should not be unavailable because a photograph could not be
   * signed.
   *
   * The link lives the storage's ten minutes and is signed afresh on every
   * call: a signed-in screen asks again, and a photo of a person is never
   * handed out for longer.
   */
  async signedUrlOrNull(gsUri: string | null): Promise<string | null> {
    if (gsUri === null) return null;

    return (await this.signOrNull(gsUri))?.url ?? null;
  }

  /**
   * A link for a public read that is cached (the menu): signed for
   * `PUBLIC_PHOTO_LINK_TTL_MS` (an hour), and the same link is handed out
   * again while at least `PUBLIC_LINK_MIN_REMAINING_MS` (45 minutes) of it
   * remains.
   *
   * - **Fast.** On Cloud Run every signature is a call to Google's signing
   *   service, one per photo; the menu has one per dish with a photo, and
   *   two with its thumbnail. Reused, a warm menu read signs nothing.
   * - **Cacheable.** The same links make the same body, so the menu's
   *   `ETag` holds and a conditional request answers 304, for up to 15
   *   minutes at a time; a fresh link per read made every body new.
   * - **Never stale past its life.** A link is handed out only with at
   *   least 45 minutes left, and the menu is cached for a minute (plus the
   *   page's own minute), so a visitor always has over 40 minutes.
   *
   * Remembered per `gs://` URI in this instance's memory, at most
   * `PUBLIC_LINK_MEMO_SIZE` of them, the oldest dropped first. A replaced
   * photo has a new URI (`store` names every upload afresh), so a link to
   * the old photo is never handed out for the new one. A signing failure
   * is not remembered: the next read tries again.
   */
  async publicSignedUrlOrNull(gsUri: string | null): Promise<string | null> {
    if (gsUri === null) return null;

    const remembered = this.publicLinks.get(gsUri);

    if (
      remembered !== undefined &&
      remembered.expiresAt.getTime() - Date.now() >=
        PUBLIC_LINK_MIN_REMAINING_MS
    ) {
      return remembered.url;
    }

    const signed = await this.signOrNull(gsUri, PUBLIC_PHOTO_LINK_TTL_MS);

    if (signed === null) return null;

    // Deleted first so a re-signed link moves to the newest end.
    this.publicLinks.delete(gsUri);
    this.publicLinks.set(gsUri, signed);

    for (const oldest of this.publicLinks.keys()) {
      if (this.publicLinks.size <= PUBLIC_LINK_MEMO_SIZE) break;
      this.publicLinks.delete(oldest);
    }

    return signed.url;
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

  /** Check, resize and write one upload; the URI and the bytes stored. */
  private async write(
    kind: PhotoKind,
    ownerId: string,
    file: UploadedImageFile | undefined,
  ): Promise<{ gsUri: string; stored: Buffer }> {
    const { bytes, image } = readUploadedImage(file);
    const stored = await this.resizer.resize(kind, bytes, image);
    const objectName = `${kind}/${ownerId}/photo-${randomUUID()}.${image.format.extension}`;

    return {
      gsUri: await this.storage.save(
        objectName,
        stored,
        image.format.contentType,
      ),
      stored,
    };
  }

  private async writeMenuThumb(itemId: string, photo: Buffer): Promise<string> {
    const thumb = await this.resizer.menuThumbnail(photo);

    return this.storage.save(
      `menu/${itemId}/thumb-${randomUUID()}.${MENU_THUMB_FORMAT.extension}`,
      thumb,
      MENU_THUMB_FORMAT.contentType,
    );
  }

  /** Sign, or log and answer null (see `signedUrlOrNull`). */
  private async signOrNull(
    gsUri: string,
    ttlMs?: number,
  ): Promise<SignedUrl | null> {
    try {
      return ttlMs === undefined
        ? await this.storage.signedUrl(gsUri)
        : await this.storage.signedUrl(gsUri, ttlMs);
    } catch (error: unknown) {
      this.logger.error(
        `Could not sign a link for ${gsUri}; answering without the photo.`,
        error instanceof Error ? error.stack : String(error),
      );

      return null;
    }
  }
}
