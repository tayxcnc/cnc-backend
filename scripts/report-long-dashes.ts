import type { PrismaClient } from '../generated/cnc-client';
import {
  createSeedClient,
  createWritingSeedClient,
} from '../prisma/seed-client';
import { LONG_DASH } from '../src/common/no-long-dashes';

/**
 * Report, and optionally clean, long dashes stored in CNC's catalogue text
 * (G2 of the platform fixes, decisions P18 and P19).
 *
 * **Read-only unless `--apply` is passed:**
 *
 *   npx ts-node -r dotenv/config scripts/report-long-dashes.ts
 *   npx ts-node -r dotenv/config scripts/report-long-dashes.ts --apply
 *
 * The report prints every value holding a long dash, before and after, so a
 * person can rewrite one by hand in the app instead (Menu And Prices and the
 * Vendor Profile refuse a long dash on save since this change, so the text
 * typed there has none). `--apply` writes the mechanical version shown.
 *
 * ## Why a script and not a migration (P19)
 *
 * Staging is wiped and production starts from the migrations and the seeds,
 * whose text holds no long dash, so no database is expected to need this.
 * It is here for one that does, and it is safe to run twice: a cleaned
 * value has nothing left to match.
 *
 * ## What it reads and writes
 *
 * Exactly the fields the app now refuses a long dash in (P18): a menu
 * item's name, description and photo text, and a vendor's name, phone,
 * service, contact person, email and address. Never the business details
 * (`Business`) or the activity history (`AuditLog`): the first is the
 * Owner's own text, printed on every receipt, and the second is a record of
 * what was done, which nothing rewrites. Never a staff note, a reason, a
 * task or anything a customer typed either, a vendor's notes included:
 * those are cleaned where the app shows them.
 *
 * ## How a value is cleaned
 *
 * The rule each app's `cleanCopy()` applies when it shows text: a long dash
 * between two digits becomes " to " ("2–4" reads "2 to 4"), one that opens
 * or closes the value is dropped, and any other becomes a comma and a
 * space. That is a safety net, not good writing, which is why the report
 * shows it first.
 *
 * ## Where it may write
 *
 * `--apply` refuses anything but a local database unless
 * `CNC_SEED_DASHES_ALLOW_REMOTE` is exactly `true` for the run, as every
 * script that writes does (*Local environment* in `docs/conventions.md`).
 * Each write names the value it read, so a staff edit saved during the run
 * wins and is counted as skipped; each written row's `version` moves by
 * one, so a form opened before the run cannot save the old text back
 * without a refresh.
 */

interface Target {
  table: 'MenuItem' | 'Vendor';
  column: string;
}

/** Read from `prisma/schema.prisma`; neither model is renamed with `@@map`. */
export const TARGETS: readonly Target[] = [
  { table: 'MenuItem', column: 'name' },
  { table: 'MenuItem', column: 'description' },
  { table: 'MenuItem', column: 'photoAlt' },
  { table: 'Vendor', column: 'name' },
  { table: 'Vendor', column: 'phone' },
  { table: 'Vendor', column: 'service' },
  { table: 'Vendor', column: 'contact' },
  { table: 'Vendor', column: 'email' },
  { table: 'Vendor', column: 'address' },
];

const DASH = LONG_DASH.source;

/** The `cleanCopy()` rule, for a stored value. See the header. */
export function withoutLongDashes(text: string): string {
  return text
    .replace(new RegExp(`(\\d)\\s*${DASH}\\s*(?=\\d)`, 'g'), '$1 to ')
    .replace(new RegExp(`^\\s*${DASH}\\s*`), '')
    .replace(new RegExp(`\\s*${DASH}\\s*$`), '')
    .replace(new RegExp(`\\s*${DASH}\\s*`, 'g'), ', ');
}

export interface Finding {
  table: Target['table'];
  column: string;
  id: string;
  before: string;
  after: string;
}

/**
 * Every stored value that holds a long dash, with what it would become.
 * Read-only, and the same read the apply path writes from.
 */
export async function findLongDashes(prisma: PrismaClient): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const { table, column } of TARGETS) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; value: string }[]>(
      `SELECT id, "${column}" AS value
         FROM "${table}"
        WHERE "${column}" ~ $1
        ORDER BY id`,
      DASH,
    );

    for (const row of rows) {
      findings.push({
        table,
        column,
        id: row.id,
        before: row.value,
        after: withoutLongDashes(row.value),
      });
    }
  }

  return findings;
}

/**
 * Write each finding, only where the row still holds the value that was
 * read, moving the row's version by one. Returns how many were written and
 * how many were skipped because the value changed in between.
 */
export async function applyFindings(
  prisma: PrismaClient,
  findings: readonly Finding[],
): Promise<{ written: number; skipped: number }> {
  let written = 0;
  let skipped = 0;

  for (const finding of findings) {
    const changed = await prisma.$executeRawUnsafe(
      `UPDATE "${finding.table}"
          SET "${finding.column}" = $1,
              "version" = "version" + 1,
              "updatedAt" = now() AT TIME ZONE 'UTC'
        WHERE id = $2 AND "${finding.column}" = $3`,
      finding.after,
      finding.id,
      finding.before,
    );

    if (changed === 1) written += 1;
    else skipped += 1;
  }

  return { written, skipped };
}

const show = (value: string) => JSON.stringify(value);

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = apply
    ? createWritingSeedClient(
        'CNC_SEED_DASHES_ALLOW_REMOTE',
        process.env.CNC_SEED_DASHES_ALLOW_REMOTE,
      )
    : createSeedClient();

  console.log(apply ? 'Mode: apply, rows will be written' : 'Mode: report');
  console.log('');

  try {
    const findings = await findLongDashes(prisma);

    if (findings.length === 0) {
      console.log(
        `No long dash in any of the ${TARGETS.length} scanned fields. ` +
          'Nothing to clean.',
      );
      return;
    }

    for (const finding of findings) {
      console.log(`${finding.table}.${finding.column} ${finding.id}`);
      console.log(`  before: ${show(finding.before)}`);
      console.log(`  after:  ${show(finding.after)}`);
    }

    console.log('');
    console.log(`${findings.length} value(s) hold a long dash.`);

    if (!apply) {
      console.log('Report only: nothing was written. Re-run with --apply.');
      return;
    }

    const { written, skipped } = await applyFindings(prisma, findings);

    console.log(`Wrote ${written}; skipped ${skipped} changed since read.`);

    const remaining = await findLongDashes(prisma);

    console.log(
      remaining.length === 0
        ? 'Checked: no long dash is left in any scanned field.'
        : `${remaining.length} value(s) still hold one. Run it again.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('The long-dash report failed.');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
