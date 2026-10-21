import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { databaseTarget } from '../prisma/local-database';
import { CncConfigService } from '../src/config/cnc.config';

/** Every isolated database's name starts with this, and nothing else's. */
const PREFIX = 'cnc_iso_';

/** A leftover from a run that died before its `drop()` is removed after this. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

/** A database of a suite's own, and the way to remove it. */
export interface IsolatedDatabase {
  /** The connection string. Never print it. */
  url: string;
  drop(): Promise<void>;
}

/**
 * A fresh, empty Postgres database beside the shared test database, with
 * every committed migration applied, for a suite that must own the whole
 * database.
 *
 * ## Why a suite would need one
 *
 * The shared test database is written by every suite in parallel, and it
 * always holds other active Owners. A test of "the only Owner cannot demote
 * themselves" (the C3 gate's step 6) or of the first Owner's temporary
 * password (step 1) needs a database where the seeded Owner is the only
 * one, and committing the deactivation of every other Owner in the shared
 * database would break the suites running beside it.
 *
 * ## How
 *
 * The database is created on the same server as `CNC_DB_URL` (read through
 * `CncConfigService`), and refused unless that is a local development
 * database by the seeds' own rule (`databaseTarget`): this never creates or
 * drops anything on staging. In CI it is the job's own container. The
 * migrations are applied from `prisma/migrations` in order, as the SQL
 * files `migrate deploy` would run, so the schema is exactly the committed
 * one; Prisma's own history table is not needed by the application.
 *
 * Each name carries its creation time. A run that dies before `drop()`
 * leaves its database behind; the next call removes any older than six
 * hours, so a crashed run costs disk for an afternoon, not forever.
 */
export async function createIsolatedDatabase(): Promise<IsolatedDatabase> {
  const baseUrl = new CncConfigService().databaseUrl;

  if (databaseTarget(baseUrl).kind !== 'local') {
    throw new Error(
      'Refusing to create an isolated test database: CNC_DB_URL is not a ' +
        'local development database.',
    );
  }

  const name = `${PREFIX}${Date.now()}_${randomBytes(4).toString('hex')}`;

  await withClient(baseUrl, async (admin) => {
    await dropStale(admin);
    await admin.query(`CREATE DATABASE "${name}"`);
  });

  const url = withDatabase(baseUrl, name);

  await withClient(url, async (client) => {
    for (const migration of migrationFiles()) {
      await client.query(readFileSync(migration, 'utf8'));
    }
  });

  return {
    url,
    drop: () =>
      withClient(baseUrl, async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }),
  };
}

/** The committed migrations' SQL files, oldest first. */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((entry) => statSync(join(MIGRATIONS, entry)).isDirectory())
    .sort()
    .map((entry) => join(MIGRATIONS, entry, 'migration.sql'));
}

/** The same server and credentials, another database. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;

  return parsed.toString();
}

async function withClient(
  url: string,
  work: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: url });

  await client.connect();

  try {
    await work(client);
  } finally {
    await client.end();
  }
}

async function dropStale(admin: Client): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE $1`,
    [`${PREFIX}%`],
  );

  for (const { datname } of rows) {
    const createdAt = Number(datname.slice(PREFIX.length).split('_')[0]);

    if (
      /^[a-z0-9_]+$/.test(datname) &&
      Number.isFinite(createdAt) &&
      Date.now() - createdAt > STALE_AFTER_MS
    ) {
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  }
}
