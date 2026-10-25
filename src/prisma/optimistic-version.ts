import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/cnc-client';
import { VERSION_FIELD_MESSAGE } from '../common/dto/versioned-write.dto';

/**
 * The one sentence a stale write is refused with (A8). Fixed, so both
 * frontends can show it as it stands.
 */
export const STALE_VERSION_MESSAGE =
  'This record changed. Refresh and try again.';

/**
 * Every table whose rows carry a `version` (A8), as of this migration
 * history. A unit test reads the generated client's model list and fails when
 * a model gains or loses a `version` field without this list following, so a
 * new versioned model cannot be written without the check being available.
 *
 * A card that adds a versioned model appends it here.
 */
export const VERSIONED_TABLES = [
  'Settings',
  'Business',
  'MenuItem',
  'Staff',
  'StockItem',
  'Order',
  'OnlineOrder',
  'KitchenEntry',
  'Reservation',
  'TableSession',
  'StockRequest',
  'Vendor',
  'Purchase',
  'WasteEntry',
  'Task',
  'Asset',
  'MaintenanceRecord',
  'AttendanceRecord',
] as const satisfies readonly Prisma.ModelName[];

export type VersionedTable = (typeof VERSIONED_TABLES)[number];

/** The arguments of {@link claimVersion}. */
export interface ClaimVersion {
  /** The table, from {@link VERSIONED_TABLES}. */
  table: VersionedTable;
  /** The row's id. */
  id: string;
  /** The `version` the caller read, from the request body. */
  version: number;
  /**
   * The sentence for a row that does not exist, from `staff/lib/domain.ts`
   * where the command has one ("Stock item not found."), so the 404 reads
   * exactly as the screen expects (A7).
   */
  notFound: string;
}

/**
 * Check a write's `version` and take the row, in one statement (A8).
 *
 * `UPDATE … SET version = version + 1 WHERE id = $1 AND version = $2`: the
 * comparison and the increment are one statement, so two writers holding the
 * same version cannot both pass. The second waits on the first's row lock;
 * when the first commits, Postgres re-reads the row, finds the version has
 * moved, and the second's update matches nothing. That is the stale write,
 * and it is refused with `409` and {@link STALE_VERSION_MESSAGE}. A row that
 * does not exist at all is `404` with the command's own sentence.
 *
 * **Call it first in the command's transaction, and only inside one.** The
 * update leaves the row locked until the transaction ends, so everything the
 * command then reads and writes on that row is protected exactly as a
 * `SELECT … FOR UPDATE` would protect it. Outside a transaction the lock is
 * released at once and the command's own write is no longer guarded.
 *
 * The command's own update must **not** increment `version` again: this has
 * done it. The new version is returned, for the response.
 *
 * `updatedAt` is set here as well, `now() AT TIME ZONE 'UTC'` (see *Data and
 * migrations*, raw-SQL timestamps), so a command that changes nothing else
 * still records when the row was last claimed.
 */
export async function claimVersion(
  tx: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>,
  claim: ClaimVersion,
): Promise<number> {
  const { table, id, version, notFound } = claim;

  // The table name is interpolated: an identifier cannot be a bind
  // parameter. It is checked against the fixed list at run time as well as
  // by the type, so a value that reached here from anywhere else cannot
  // become SQL.
  if (!(VERSIONED_TABLES as readonly string[]).includes(table)) {
    throw new Error(`${String(table)} is not a versioned table.`);
  }

  if (!Number.isSafeInteger(version) || version < 0) {
    // `VersionedWriteDto` refuses this with the same 400 first; reaching here
    // is a route that skipped it. A non-integer would otherwise reach
    // Postgres as a type error and answer 500.
    throw new BadRequestException(VERSION_FIELD_MESSAGE);
  }

  const claimed = await tx.$queryRawUnsafe<{ version: number }[]>(
    `UPDATE "${table}"
        SET "version" = "version" + 1,
            "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE "id" = $1 AND "version" = $2
  RETURNING "version"`,
    id,
    version,
  );

  if (claimed.length === 1) {
    return Number(claimed[0].version);
  }

  const existing = await tx.$queryRawUnsafe<{ found: number }[]>(
    `SELECT 1 AS "found" FROM "${table}" WHERE "id" = $1`,
    id,
  );

  if (existing.length === 0) {
    throw new NotFoundException(notFound);
  }

  throw new ConflictException(STALE_VERSION_MESSAGE);
}
