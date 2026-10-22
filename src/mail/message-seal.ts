import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CncConfigService } from '../config/cnc.config';

/** The version tag every sealed payload starts with. */
const VERSION = 'v1';

/**
 * The HKDF label. A key derived under its own label is independent of the
 * JWT signing key it comes from: knowing one tells nothing about the other.
 */
const KEY_INFO = 'cnc:outbound-message-payload:v1';

const IV_BYTES = 12;

/**
 * Seals and opens `OutboundMessage.payload`: AES-256-GCM, with a key derived
 * by HKDF-SHA256 from `CNC_JWT_SECRET` under its own label.
 *
 * ## Why a message's payload is sealed
 *
 * A sign-in code exists in clear only in the request that drew it and in
 * the email. The queue must still be able to re-send the email when the
 * first send fails or mail is not yet configured on staging, so the code
 * has to be stored somewhere until then. Stored in clear, a database read
 * (a backup, a support query, a leaked dump) would yield a working code
 * for ten minutes and undo `OtpCode.codeHash`. Sealed, the row is useless
 * without the service's signing secret, which the database never holds.
 * Booking and order messages carry names and addresses, so every payload
 * is sealed alike rather than judged case by case.
 *
 * ## Why the JWT secret, and not a new one
 *
 * A new secret is a new Secret Manager entry and a deploy change on every
 * environment, for a value that only needs to be held by this service and
 * not by the database. `CNC_JWT_SECRET` is exactly that, at least 32
 * characters and never a placeholder (the boot rules). HKDF under a
 * distinct label makes the derived key independent of the signing key.
 * Rotating the JWT secret makes waiting payloads unreadable; the queue then
 * gives those messages up, which costs a few minutes of retries at most.
 *
 * The output is `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 */
@Injectable()
export class MessageSeal {
  private readonly key: Buffer;

  constructor(config: CncConfigService) {
    this.key = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(config.jwtSecret, 'utf8'),
        Buffer.alloc(0),
        Buffer.from(KEY_INFO, 'utf8'),
        32,
      ),
    );
  }

  seal(value: unknown): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);

    return [
      VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      data.toString('base64url'),
    ].join('.');
  }

  /**
   * The value `seal` was given. Throws on anything else: another version,
   * a tampered or truncated payload, or one sealed under another secret.
   */
  open(sealed: string): unknown {
    const parts = sealed.split('.');

    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Not a sealed payload.');
    }

    const [, iv, tag, data] = parts;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));

    const json = Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');

    return JSON.parse(json) as unknown;
  }
}
