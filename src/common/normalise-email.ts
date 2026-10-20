/**
 * Trim an email address and lower-case it, copied from TAY.
 *
 * Applied through `@Transform` on every request field that names a person by
 * email: staff sign-in now, staff creation (C3-6) and the customer code
 * sign-in (C6) later. Staff and customer emails are stored lower case, and a
 * CHECK refuses anything else, so a lookup that read the address verbatim
 * would refuse `Ada@cnc.example` for an account stored as
 * `ada@cnc.example`, the same person typed with a capital letter.
 *
 * Non-strings pass through untouched: validation has not run yet at
 * transform time, and coercing here would replace `@IsEmail`'s clear 400
 * with a confusing one.
 */
export function normaliseEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}
