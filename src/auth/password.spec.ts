import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './password';

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
});
