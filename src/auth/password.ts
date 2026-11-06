import { randomBytes } from 'node:crypto';
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

/** Random bytes in a temporary password: 80 bits. */
const TEMPORARY_PASSWORD_BYTES = 10;

/**
 * A machine-chosen password for an account an Owner or a manager has reset
 * (C3-3), and for a new account (C3-6). The holder must replace it at first
 * sign-in (`mustChangePassword`).
 *
 * TAY emails its generated password; CNC shows it once to the manager who
 * reset the account, who hands it over in person. C3 built it so before
 * CNC had mail, and it stays so (C8-5): a staff member who forgot their
 * password is at the venue, and a password in an inbox outlives its first
 * use. It is therefore shorter than TAY's 32 hex characters and
 * grouped for reading aloud: 20 lower-case hex characters in five groups of
 * four (`3f9a-07c2-…`). Hex has no case to get wrong and no look-alike
 * letters. 80 bits is far beyond reach of a sign-in route that allows ten
 * guesses per fifteen minutes and costs an argon2 verification each.
 */
export function generateTemporaryPassword(): string {
  const hex = randomBytes(TEMPORARY_PASSWORD_BYTES).toString('hex');

  return hex.match(/.{4}/g)!.join('-');
}

/** Hex characters in a temporary password: two per random byte. */
const TEMPORARY_PASSWORD_HEX = TEMPORARY_PASSWORD_BYTES * 2;

/**
 * A temporary password as it was typed, read back into the form
 * `generateTemporaryPassword` stores (`3f9a-07c2-…`), or null when it is not
 * one. A person reading it off one device and typing it on an iPad keyed it
 * wrong in ways that do not change which password it is: capitals, spaces,
 * a dash left out or an en dash for the hyphen, "o" for zero, "l" or "i"
 * for one. Hex has none of those letters, so reading them back adds no
 * guess: the password is still the same 80 bits. Anything else in the text,
 * a stray letter or a character autofill left in the field, means it is not
 * the password, and null.
 */
export function readTemporaryPassword(typed: string): string | null {
  const hex = typed
    .toLowerCase()
    .replace(/[\s\p{Pd}−]/gu, '')
    .replace(/o/g, '0')
    .replace(/[li]/g, '1');

  if (!new RegExp(`^[0-9a-f]{${TEMPORARY_PASSWORD_HEX}}$`).test(hex)) {
    return null;
  }

  return hex.match(/.{4}/g)!.join('-');
}

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
