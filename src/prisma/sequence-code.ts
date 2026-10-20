import type { CncPrismaService } from './cnc-prisma.service';

/**
 * Human-readable codes drawn from a Postgres sequence.
 *
 * Every human number in this service has one, one sequence per prefix (plan
 * A12): `Customer.memberNo` (`CNC-000001`), `Staff.staffNo` (`CNC-S001`), the
 * order numbers (`CNCR-000001`, `CNCB-000001`) and the rest. They are printed,
 * quoted over the phone and expected to look sequential, and the obvious way
 * to generate them is wrong — read the highest stored value and add one, which
 * is two statements with a gap in between. Two orders landing in that gap
 * compute the same number, one loses the unique index, and a cashier is told
 * the server broke. That race is reproducible on demand with a dozen
 * concurrent writers.
 *
 * `nextval` is atomic and takes no transaction-level lock, so concurrent
 * callers are handed different numbers however many arrive at once.
 *
 * ## Two properties every caller inherits
 *
 * **The numbering has gaps.** A sequence burns its value whether or not the
 * transaction commits, so anything that fails after drawing a code leaves a
 * hole. Closing that would mean serialising every draw behind a lock, which is
 * the contention this exists to remove. These codes identify a record for a
 * person to quote; none of them is a gapless fiscal series, so a gap costs
 * nothing.
 *
 * **`minDigits` is a floor, not a width.** `padStart` leaves a longer number
 * alone, so `CNC-999999` is followed by `CNC-1000000`. Anything matching one
 * of these codes wants `\d{6,}` rather than `\d{6}`, and **nothing may order
 * by the string** — lexical order stops matching numeric order at exactly that
 * boundary. Order by the row's `createdAt` or by the numeric part.
 *
 * ## The one way to break it
 *
 * A code written **without** the sequence and above its position will collide
 * once the sequence catches up. Anything that bulk-imports rows, or restores
 * them from an older backup, must re-seed the sequence afterwards — the
 * `setval` statement in each sequence's migration is the one to repeat, and it
 * is idempotent. Retrying is not a fix for that; it only walks past as many
 * rows as it has attempts.
 */
export async function nextSequenceCode(
  prisma: Pick<CncPrismaService, '$queryRawUnsafe'>,
  sequence: string,
  prefix: string,
  minDigits: number,
): Promise<string> {
  // `$queryRawUnsafe` because a sequence name cannot be a bind parameter —
  // Postgres takes it as a value, not an identifier. The name is never taken
  // from a request: every caller passes a literal naming a sequence created by
  // a migration in this repository, and the assertion below refuses anything
  // that is not a bare identifier so a future caller cannot make it a hole.
  if (!/^[a-z_][a-z0-9_]*$/.test(sequence)) {
    throw new Error(
      `"${sequence}" is not a plain sequence name. This value is interpolated ` +
        `into SQL and must be a literal in this repository, never anything ` +
        `derived from a request.`,
    );
  }

  const rows = await prisma.$queryRawUnsafe<{ next: bigint }[]>(
    `SELECT nextval('${sequence}') AS next`,
  );

  const next = rows[0]?.next;

  if (next === undefined) {
    // Unreachable against a migrated database: `nextval` returns exactly one
    // row or raises. Present so a missing sequence fails here, naming itself,
    // rather than producing a code reading `CNCR-undefined`.
    throw new Error(
      `The sequence ${sequence} returned no value. Has its migration been ` +
        `applied?`,
    );
  }

  // Stringified rather than converted to a number. `Number` is exact to 2^53
  // and silently wrong after it, and a code that starts repeating is worse
  // than one that is long.
  return `${prefix}${String(next).padStart(minDigits, '0')}`;
}
