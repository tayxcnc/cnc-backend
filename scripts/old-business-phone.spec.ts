import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  OLD_BUSINESS_DIGITS,
  spelledOldNumber,
} from '../test/old-business-phone';

/**
 * CNC's old business phone appears nowhere in the code (batch 2, section 2:
 * the number CNC shows is now 0911 350 0003).
 *
 * The old number comes from `test/old-business-phone.ts`, held in pieces,
 * so this file never matches itself and the workspace's old-number search
 * (platform fixes plan §7.1) prints nothing for it either.
 *
 * The match allows any spacing, hyphens, brackets, dots or a comment's line
 * break between the digits, so the `0`, `+234` and `234` spellings, grouped
 * or not, are all caught: the prefix is left out of the match, and every
 * spelling ends in the same ten digits.
 *
 * `prisma/migrations` is not scanned: the contact details migration has to
 * name the old number to find a row still holding it, and a migration is
 * never edited once it has been applied.
 */
const BETWEEN_DIGITS = String.raw`[\s().*/\-]*`;

const OLD_NUMBER = new RegExp(
  OLD_BUSINESS_DIGITS.split('').join(BETWEEN_DIGITS),
);

const ROOT = join(__dirname, '..');

/** The directories scanned, relative to the repository root. */
const SCANNED = ['src', 'prisma', 'scripts', 'test'];

/** Left out, relative to the repository root. */
const MIGRATIONS = join('prisma', 'migrations') + sep;

/** Every file under the scanned directories, as `dir/…` paths. */
function scannedFiles(): string[] {
  return SCANNED.flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(entry.parentPath, entry.name).slice(ROOT.length + sep.length),
      ),
  ).filter((file) => !file.startsWith(MIGRATIONS));
}

describe('the old business phone', () => {
  it('is caught however it is spelled', () => {
    for (const written of [
      spelledOldNumber('0', ''),
      spelledOldNumber('0', ' '),
      spelledOldNumber('0', '-'),
      spelledOldNumber('+234 ', ' '),
      spelledOldNumber('+234', ''),
      spelledOldNumber('234', ''),
      spelledOldNumber('+234 (0)', ' '),
      spelledOldNumber('(0', ') '),
      spelledOldNumber('0', '.'),
      spelledOldNumber('0', ' \n * '),
    ]) {
      expect({ written, caught: OLD_NUMBER.test(written) }).toEqual({
        written,
        caught: true,
      });
    }
  });

  it('does not catch the new numbers or another phone', () => {
    for (const written of [
      '09113500003',
      '0911 350 0003',
      '+2349113500003',
      '09113500004',
      '08031234567',
    ]) {
      expect({ written, caught: OLD_NUMBER.test(written) }).toEqual({
        written,
        caught: false,
      });
    }
  });

  it('appears in no file under src/, prisma/ (migrations aside), scripts/ or test/', () => {
    const files = scannedFiles();

    // The scan reaches the files it is meant to read.
    expect(files).toEqual(
      expect.arrayContaining([
        join('src', 'common', 'nigerian-phone.ts'),
        join('prisma', 'schema.prisma'),
        join('prisma', 'seed-data', 'reference.ts'),
        join('scripts', 'old-business-phone.spec.ts'),
        join('test', 'settings.e2e-spec.ts'),
      ]),
    );
    // Migrations are skipped, and only because the one that replaces the
    // old number has to name it.
    const migrations = readdirSync(join(ROOT, MIGRATIONS), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const naming = migrations.filter((name) =>
      OLD_NUMBER.test(
        readFileSync(join(ROOT, MIGRATIONS, name, 'migration.sql'), 'utf8'),
      ),
    );

    expect(naming.map((name) => name.replace(/^\d+_/, ''))).toEqual([
      'contact_details_batch2',
    ]);

    // The whole file at once, so a number broken across a comment's line is
    // still caught; each hit is named by the line it starts on.
    const everywhere = new RegExp(OLD_NUMBER.source, 'g');
    const hits = files.flatMap((file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');

      return [...text.matchAll(everywhere)].map(
        (match) => `${file}:${text.slice(0, match.index).split('\n').length}`,
      );
    });

    expect(hits).toEqual([]);
  });
});
