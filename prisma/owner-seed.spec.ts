import {
  DEFAULT_OWNER_NAME,
  EXAMPLE_PASSWORD,
  OwnerSeedRefusal,
  readOwnerSeedInput,
} from './owner-seed';

/**
 * The Owner seed's checks on its variables, made before any connection. The
 * writes themselves are in `test/seed.e2e-spec.ts`, against Postgres.
 */
describe('readOwnerSeedInput', () => {
  const valid = {
    email: 'owner@cnc.test',
    password: 'a-long-enough-password',
    name: 'Sandra Silas',
  };

  it('trims and lower-cases the email and keeps the password exactly', () => {
    expect(
      readOwnerSeedInput({
        ...valid,
        email: '  Owner@CNC.test ',
        password: ' spaced password ',
      }),
    ).toEqual({
      email: 'owner@cnc.test',
      password: ' spaced password ',
      name: 'Sandra Silas',
    });
  });

  it.each([
    ['unset', undefined],
    ['blank', '   '],
  ])('falls back to a plain name when the name is %s', (_case, name) => {
    expect(readOwnerSeedInput({ ...valid, name }).name).toBe(
      DEFAULT_OWNER_NAME,
    );
  });

  it.each([
    ['the email is unset', { email: undefined }],
    ['the email is blank', { email: '  ' }],
    ['the password is unset', { password: undefined }],
    ['the password is empty', { password: '' }],
  ])('refuses when %s, with no default to fall back on', (_case, change) => {
    expect(() => readOwnerSeedInput({ ...valid, ...change })).toThrow(
      new OwnerSeedRefusal(
        'Set both CNC_SEED_OWNER_EMAIL and CNC_SEED_OWNER_PASSWORD before ' +
          'seeding the Owner: in .env for a local run, or in the shell for a ' +
          'one-off. There is no default for either.',
      ),
    );
  });

  it('refuses something that is not an email address', () => {
    expect(() =>
      readOwnerSeedInput({ ...valid, email: 'owner-at-cnc' }),
    ).toThrow('CNC_SEED_OWNER_EMAIL is not an email address.');
  });

  it('refuses the .env.example placeholder password', () => {
    expect(() =>
      readOwnerSeedInput({ ...valid, password: EXAMPLE_PASSWORD }),
    ).toThrow(/still the \.env\.example placeholder/);
  });

  it('refuses a password under eight characters, and takes eight', () => {
    expect(() => readOwnerSeedInput({ ...valid, password: '1234567' })).toThrow(
      'CNC_SEED_OWNER_PASSWORD must be at least 8 characters.',
    );
    expect(
      readOwnerSeedInput({ ...valid, password: '12345678' }).password,
    ).toBe('12345678');
  });

  it('never puts the password in a refusal', () => {
    const password = 'Pw7';
    let message = '';

    try {
      readOwnerSeedInput({ ...valid, password });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/must be at least/);
    expect(message).not.toContain(password);
  });
});
