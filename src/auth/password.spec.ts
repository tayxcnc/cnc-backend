import {
  generateTemporaryPassword,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  readTemporaryPassword,
  verifyPassword,
} from './password';

describe('password hashing', () => {
  it('hashes with argon2id at the cost every writer shares', async () => {
    const stored = await hashPassword('correct horse battery');

    // The digest records its own algorithm and parameters.
    expect(stored.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
  });

  it('verifies the right password and refuses a wrong one', async () => {
    const stored = await hashPassword('correct horse battery');

    await expect(verifyPassword(stored, 'correct horse battery')).resolves.toBe(
      true,
    );
    await expect(verifyPassword(stored, 'Correct horse battery')).resolves.toBe(
      false,
    );
  });

  it('salts every hash, so one password never hashes the same twice', async () => {
    const [first, second] = await Promise.all([
      hashPassword('same password'),
      hashPassword('same password'),
    ]);

    expect(first).not.toBe(second);
  });

  it('answers false, never throws, for a hash that is not argon2', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it("keeps TAY's eight-character minimum", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
  });

  it('generates temporary passwords as five groups of four hex characters', () => {
    const passwords = Array.from({ length: 50 }, generateTemporaryPassword);

    for (const password of passwords) {
      expect(password).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);
      expect(password.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    }
    expect(new Set(passwords).size).toBe(passwords.length);
  });

  it('reads a temporary password typed loosely back into its stored form', () => {
    const stored = '3f9a-07c2-b1d0-e4a8-5c6f';

    for (const typed of [
      stored,
      '3F9A-07C2-B1D0-E4A8-5C6F',
      '3f9a07c2b1d0e4a85c6f',
      ' 3f9a 07c2 b1d0 e4a8 5c6f ',
      '3f9a–07c2—b1d0−e4a8‐5c6f',
      '3f9a-o7c2-bld0-e4a8-5c6f',
      '3f9a-07c2-bId0-e4a8-5c6f',
    ]) {
      expect(readTemporaryPassword(typed)).toBe(stored);
    }
  });

  it('reads nothing that is not a temporary password', () => {
    for (const typed of [
      'correct horse battery',
      '3f9a-07c2-b1d0-e4a8',
      '3f9a-07c2-b1d0-e4a8-5c6f0',
      '3f9a-07c2-b1d0-e4a8-5c6fx',
      '3f9a-07c2-b1d0-e4a8-5c6f!',
      'Password1-3f9a-07c2-b1d0-e4a8-5c6f',
      '',
    ]) {
      expect(readTemporaryPassword(typed)).toBeNull();
    }
  });

  it('reads back every generated password as itself', () => {
    for (const password of Array.from(
      { length: 50 },
      generateTemporaryPassword,
    )) {
      expect(readTemporaryPassword(password)).toBe(password);
    }
  });
});
