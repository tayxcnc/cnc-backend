/**
 * The staff app's email shape (`staff/lib/domain.ts`, `staff.save` and
 * `settings.save` both use it): something, an `@`, something, a dot,
 * something, with no spaces. Applied after the address is trimmed and
 * lower-cased (`normaliseEmail`).
 *
 * Shared in `src/common` because the sign-in email of a staff account and
 * the business's own email are checked by the same rule, and two copies of
 * a format rule have nothing forcing them to agree.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
