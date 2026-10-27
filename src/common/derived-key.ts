import { hkdfSync } from 'node:crypto';

/**
 * A 256-bit key derived from one of the service's secrets by HKDF-SHA256
 * under its own label (`info`). Keys derived under different labels are
 * independent of each other and of the secret they come from: knowing one
 * tells nothing about another.
 *
 * Used where the service needs a key that only it holds and the database
 * never does: the outbound payload seal (`MessageSeal`) and the keyed digest
 * of a one-time code (`OtpService`), each from `CNC_JWT_SECRET` under its
 * own label, so neither needs a new Secret Manager entry. One function, so
 * every derivation is the same construction.
 */
export function deriveKey(secret: string, label: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.alloc(0),
      Buffer.from(label, 'utf8'),
      32,
    ),
  );
}
