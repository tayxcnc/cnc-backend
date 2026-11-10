/**
 * Nigerian mobile number, as the Conventions block in `prisma/schema.prisma`
 * states it.
 *
 * That block puts this check in the DTO layer deliberately. The column is a
 * plain String and the database will store whatever it is handed, so a format
 * rule that is not enforced at the edge is not enforced anywhere.
 *
 * Shared rather than living in one DTO, because every body that takes a phone
 * number validates the same field. Two copies of a format rule would have
 * nothing forcing them to agree, and the visible failure would be a number a
 * customer could save in one place but not use in another.
 *
 * `0803…` and `+234803…` are both accepted.
 */
export const NIGERIAN_PHONE = /^(\+234|0)[789][01]\d{8}$/;

/**
 * A number that passes `NIGERIAN_PHONE`, in the one form CNC stores: `0`
 * plus 10 digits. `08031234567` and `+2348031234567` both come back
 * `08031234567`.
 *
 * The local form, not `+234…`, because the plan stores it (§4.2: a
 * customer's `phone` is "`0`+10 digits"), the business's own number is
 * stored that way (`09113500003`), and it is the form every CNC screen shows
 * and every guest types. TAY's copy of this helper returns `+234…`; the two
 * services never compare numbers with each other, so they need not agree.
 * `Customer.phone` carries a CHECK refusing any other spelling.
 *
 * For a number that is **compared**, not merely shown. A phone that must be
 * unique, or that a duplicate check matches on, has two spellings for one
 * person; stored as typed they would pass as two people.
 *
 * Throws on anything `NIGERIAN_PHONE` refuses, rather than guessing a form
 * for it: the DTO has already validated the value, so reaching here with
 * another is a route that skipped the check.
 */
/**
 * A stored number as the website shows it: `09113500003` becomes
 * `0911 350 0003` (`cnc-frontend/lib/site.ts`, `phoneDisplay`), so an email
 * prints CNC's number the way the site does and a guest reads and dials it
 * the same. Anything not in the stored form (`0` plus 10 digits) comes back
 * unchanged rather than guessed at.
 */
export function phoneForDisplay(stored: string): string {
  const match = /^(0\d{3})(\d{3})(\d{4})$/.exec(stored);

  return match === null ? stored : `${match[1]} ${match[2]} ${match[3]}`;
}

export function canonicalNigerianPhone(value: string): string {
  if (!NIGERIAN_PHONE.test(value)) {
    throw new Error(
      'canonicalNigerianPhone was handed a value NIGERIAN_PHONE refuses. ' +
        'Validate the number before storing it.',
    );
  }

  return value.startsWith('+234') ? `0${value.slice('+234'.length)}` : value;
}
