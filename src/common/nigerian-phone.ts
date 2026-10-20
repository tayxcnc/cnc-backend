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
 * A number that passes `NIGERIAN_PHONE`, in the one form `+234…`:
 * `08031234567` and `+2348031234567` both come back `+2348031234567`.
 *
 * For a number that is **compared**, not merely shown. A phone that must be
 * unique, or that a duplicate check matches on, has two spellings for one
 * person; stored as typed they would pass as two people.
 *
 * Throws on anything `NIGERIAN_PHONE` refuses, rather than guessing a form
 * for it: the DTO has already validated the value, so reaching here with
 * another is a route that skipped the check.
 */
export function canonicalNigerianPhone(value: string): string {
  if (!NIGERIAN_PHONE.test(value)) {
    throw new Error(
      'canonicalNigerianPhone was handed a value NIGERIAN_PHONE refuses. ' +
        'Validate the number before storing it.',
    );
  }

  return value.startsWith('0') ? `+234${value.slice(1)}` : value;
}
