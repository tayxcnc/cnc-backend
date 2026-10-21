/**
 * The `staff.save` and `staff.photo` sentences, byte for byte from
 * `staff/lib/domain.ts` (A7). The screens show them as they stand, so they
 * live here once and the DTOs, the service and the tests import them.
 *
 * The Manager/Owner account rule and the last-Owner rule are money controls
 * and live in `MoneyControlService`; "Staff account not found." is the
 * admin reset's, in `staff-auth.service.ts`.
 */

/** A missing name or an unknown role. */
export const STAFF_NAME_AND_ROLE_MESSAGE = 'Enter a staff name and role.';

/** A sign-in email that is not an address. */
export const STAFF_EMAIL_INVALID_MESSAGE = 'Enter a valid sign-in email.';

/** A sign-in email another account holds (409). */
export const STAFF_EMAIL_TAKEN_MESSAGE =
  'This sign-in email already belongs to another account.';

/** Changing a sign-in email without a reason. */
export const STAFF_EMAIL_REASON_MESSAGE =
  'Record a reason for changing the sign-in email.';

/** Changing a name without a reason. */
export const STAFF_NAME_REASON_MESSAGE =
  'Record a reason for correcting a name. A new person needs a new account.';

/** A non-manager changing someone else's photograph. */
export const OWN_PHOTO_ONLY_MESSAGE =
  'You can update only your own photograph.';

/** Longest name accepted; new, because the demo has none. */
export const STAFF_NAME_MAX_LENGTH = 120;

/** Longest reason accepted for a correction. */
export const REASON_MAX_LENGTH = 500;
