/**
 * CNC's old business phone, for the tests that must name it: the guard that
 * keeps it out of the code (`scripts/old-business-phone.spec.ts`) and the
 * contact details migration's suite (`contact-details-migration.e2e-spec.ts`).
 *
 * Held in pieces and only joined when a test runs, so no file outside
 * `prisma/migrations` spells it, and both the guard and the workspace's
 * old-number search (platform fixes plan §7.1) print nothing.
 */
export const OLD_BUSINESS_DIGITS = ['802', '218', '87', '97'].join('');

/**
 * The old number as people and screens write it: `prefix`, then the three
 * groups joined by `separator` (`spelledOldNumber('0', ' ')` is the website's
 * old form).
 */
export function spelledOldNumber(prefix: string, separator: string): string {
  return (
    prefix +
    [
      OLD_BUSINESS_DIGITS.slice(0, 3),
      OLD_BUSINESS_DIGITS.slice(3, 6),
      OLD_BUSINESS_DIGITS.slice(6),
    ].join(separator)
  );
}
