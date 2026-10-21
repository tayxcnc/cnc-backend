import { createSeedClient, createWritingSeedClient } from './seed-client';

/**
 * The factory's one rule: no URL is an error at the top of the run. No
 * database — the refusal comes before any client is built.
 */
describe('createSeedClient', () => {
  const saved = process.env.CNC_DB_URL;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CNC_DB_URL;
    } else {
      process.env.CNC_DB_URL = saved;
    }
  });

  it('refuses to start when CNC_DB_URL is unset', () => {
    delete process.env.CNC_DB_URL;

    expect(() => createSeedClient()).toThrow(/CNC_DB_URL is not set/);
  });

  it('refuses to start when CNC_DB_URL is empty', () => {
    process.env.CNC_DB_URL = '';

    expect(() => createSeedClient()).toThrow(/CNC_DB_URL is not set/);
  });
});

/**
 * The writing seeds' door: the remote-database check runs before a client
 * exists. Building a client does not connect, so no database is needed.
 */
describe('createWritingSeedClient', () => {
  const saved = process.env.CNC_DB_URL;
  const FLAG = 'CNC_SEED_DATA_ALLOW_REMOTE';

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.CNC_DB_URL;
    } else {
      process.env.CNC_DB_URL = saved;
    }
  });

  it('refuses to start when CNC_DB_URL is unset', () => {
    delete process.env.CNC_DB_URL;

    expect(() => createWritingSeedClient(FLAG, undefined)).toThrow(
      /CNC_DB_URL is not set/,
    );
  });

  it.each([
    ['a remote host', 'postgresql://u:p@db.example.test:5432/cnc_db'],
    ['the Cloud SQL proxy', 'postgresql://u:p@localhost:5433/cnc_db'],
  ])('refuses %s without its flag, naming the flag', (_case, url) => {
    process.env.CNC_DB_URL = url;

    expect(() => createWritingSeedClient(FLAG, undefined)).toThrow(
      /^Refusing to run: .* Set CNC_SEED_DATA_ALLOW_REMOTE=true for the run/,
    );
    expect(() => createWritingSeedClient(FLAG, 'yes')).toThrow(
      /^Refusing to run/,
    );
  });

  it('never prints the URL, which carries the password', () => {
    process.env.CNC_DB_URL = 'postgresql://u:secretpw@db.example.test:5432/x';
    let message = '';

    try {
      createWritingSeedClient(FLAG, undefined);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/db\.example\.test:5432/);
    expect(message).not.toContain('secretpw');
  });

  it('builds a client for a local database, or a remote one with the flag exactly true', async () => {
    for (const [url, flag] of [
      ['postgresql://u:p@localhost:5432/cnc_db', undefined],
      ['postgresql://u:p@db.example.test:5432/cnc_db', 'true'],
    ] as const) {
      process.env.CNC_DB_URL = url;

      const client = createWritingSeedClient(FLAG, flag);

      // Not `toBeInstanceOf(PrismaClient)`: Prisma 7's constructor returns
      // an object of its own internal class.
      expect(typeof client.$transaction).toBe('function');
      expect(client.menuItem).toBeDefined();
      await client.$disconnect();
    }
  });
});
