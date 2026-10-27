/**
 * How long a signed download link lives, unless a caller asks for less:
 * ten minutes, TAY's figure. Long enough to load a page on a poor connection,
 * short enough that a link pasted into a group chat or caught in a proxy log
 * stops working before it travels far. A screen that needs the photo again
 * asks again.
 */
export const DEFAULT_SIGNED_URL_TTL_MS = 10 * 60 * 1000;

/** A signed read link and the instant it stops working. */
export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

/**
 * CNC's private media bucket (A17), as the rest of the service sees it.
 *
 * An abstract class rather than an interface, so it is also the Nest
 * injection token: the service binds it to `GcsMediaStorage`, and the e2e
 * harness binds it to an in-memory fake, so no test ever writes to a real
 * bucket and no test needs Google credentials.
 *
 * ## What callers store
 *
 * The `gs://bucket/object` URI that `save` returns, never a signed URL. A
 * signed URL expires, so a stored one is a link that worked once; the URI
 * says the object exists and where, and a fresh link is minted per read.
 * The bucket is part of the URI, so an object written before a bucket change
 * still resolves afterwards.
 *
 * ## Never public
 *
 * Nothing here makes an object public or returns an unsigned URL. Staff
 * photographs are faces; menu photographs are less private, but one rule for
 * the bucket is a rule nobody has to remember the exceptions to.
 */
export abstract class MediaStorage {
  /** Write an object; returns the `gs://` URI to record against it. */
  abstract save(
    objectName: string,
    body: Buffer,
    contentType: string,
  ): Promise<string>;

  /** A short-lived V4 signed read link for a stored `gs://` URI. */
  abstract signedUrl(gsUri: string, ttlMs?: number): Promise<SignedUrl>;

  /** Delete an object; one that is already gone counts as deleted. */
  abstract remove(gsUri: string): Promise<void>;
}

/**
 * Split a stored `gs://bucket/object` URI, or throw. A value that does not
 * parse is a corrupted column, not a missing file, so it is never quietly
 * read against the configured bucket instead.
 */
export function parseGsUri(gsUri: string): {
  bucket: string;
  objectName: string;
} {
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(gsUri);

  if (match === null) {
    // The URI is a storage path, not a secret, so naming it helps whoever
    // reads the log find the row.
    throw new Error(`Not a gs:// URI: ${gsUri}`);
  }

  return { bucket: match[1], objectName: match[2] };
}
