import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/cnc-client';
import { remoteDatabaseRefusal } from './local-database';

/**
 * The client a seed script runs against.
 *
 * Seeds run outside the Nest container, so they cannot take CncPrismaService
 * from DI. Since Prisma 7 the client needs a driver adapter, and the adapter
 * needs the URL, so every seed shares this one factory rather than each
 * carrying a copy of the same six lines.
 *
 * CNC_DB_URL is read from `process.env` because every seed is invoked as
 * `ts-node -r dotenv/config prisma/seed-*.ts`, which has already loaded `.env`.
 * A missing value is an error here, at the top of the run, rather than a
 * connection to nowhere a few statements in.
 *
 * A seed that writes also asks `remoteDatabaseRefusal` (`local-database.ts`)
 * before it connects, with its own `CNC_SEED_<X>_ALLOW_REMOTE` flag.
 */
export function createSeedClient(): PrismaClient {
  const connectionString = process.env.CNC_DB_URL;

  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'CNC_DB_URL is not set. Seeds read it from .env via `-r dotenv/config`.',
    );
  }

  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * The client a seed that writes runs against: `createSeedClient`, after
 * `remoteDatabaseRefusal` has passed.
 *
 * Every writing seed calls this one function with its own flag, so none can
 * forget the check or run it after connecting. The caller passes the flag's
 * name and its value read by that literal name
 * (`process.env.CNC_SEED_OWNER_ALLOW_REMOTE`), so `check:env-names` sees the
 * read. The refusal names the host and port, never the URL, which carries
 * the password.
 */
export function createWritingSeedClient(
  allowRemoteFlag: string,
  allowRemoteValue: string | undefined,
): PrismaClient {
  const connectionString = process.env.CNC_DB_URL;

  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'CNC_DB_URL is not set. Seeds read it from .env via `-r dotenv/config`.',
    );
  }

  const refusal = remoteDatabaseRefusal(
    connectionString,
    allowRemoteFlag,
    allowRemoteValue,
  );

  if (refusal !== null) {
    throw new Error(refusal);
  }

  return createSeedClient();
}
