import { randomBytes } from 'node:crypto';

/** Entropy of a staff QR token, in bytes. 32 bytes is 256 bits. */
const QR_TOKEN_BYTES = 32;

/**
 * Mint a staff member's QR token (`Staff.qrToken`, plan §4.2), copied from
 * TAY's `generateQrToken`.
 *
 * The QR payload is `CNC-ID:<staffNo>:<token>`, and the token is the part
 * that proves possession: the staff number is printed and handed around. So
 * it is 32 bytes of `randomBytes` and nothing about it is derivable from
 * anything else; a cuid would not do, because it embeds a timestamp and a
 * counter, and holding one narrows the search for the next.
 *
 * base64url, so the value goes into a QR payload or a URL without escaping.
 *
 * Every writer of the column mints through here: the Owner seed now, staff
 * creation and the QR reissue route in C3-6. Two copies would be two places
 * for the entropy or the encoding to drift.
 */
export function generateQrToken(): string {
  return randomBytes(QR_TOKEN_BYTES).toString('base64url');
}
