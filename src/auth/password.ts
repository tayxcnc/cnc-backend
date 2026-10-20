import { hash, verify } from '@node-rs/argon2';

/**
 * Staff password hashing (A14): argon2id with one set of cost parameters,
 * for every writer of `Staff.passwordHash`.
 *
 * Copied from TAY's `TayPasswordService`, with one change: the parameters
 * live in this module and every writer imports them. TAY's first-admin seed
 * carries its own copy of the constants, and its comment explains why that
 * is dangerous: an argon2 digest records its own parameters, so a hash made
 * at a lower cost still verifies at sign-in, and an account protected more
 * weakly than the rest says so nowhere. Here the seed (`prisma/owner-seed.ts`)
 * and the staff auth service (C3-3) hash through the same function, so the
 * two cannot drift.
 *
 * Argon2id, never bcrypt: bcrypt truncates at 72 bytes and has no
 * memory-hardness parameter. Refresh and reset tokens are the opposite case,
 * 256 random bits with nothing to guess, and are stored as a plain SHA-256.
 */

/**
 * argon2id, spelled as its numeric value. `@node-rs/argon2` exports
 * `Algorithm` as an ambient `const enum`, which `isolatedModules` forbids
 * importing. It is also the library's default; it is spelled out so an
 * upgrade that changed the default could not change it here.
 */
const ARGON2ID = 2;

/**
 * Roughly the OWASP baseline for interactive sign-in: 19 MiB of memory, two
 * passes, one lane. TAY's values, so a CNC hash costs what a TAY hash costs.
 */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * The shortest password accepted, TAY's rule. The seed refuses a shorter
 * one, and the change-password and reset requests (C3-3) use the same
 * number.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** Hash a plaintext password for `Staff.passwordHash`. */
export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Whether `plaintext` matches a stored hash. A malformed or foreign hash is
 * a failed match, not a crash.
 */
export async function verifyPassword(
  storedHash: string,
  plaintext: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}
