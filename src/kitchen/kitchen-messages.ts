/**
 * The kitchen commands' sentences, byte for byte from `staff/lib/domain.ts`
 * (A7): `kitchen.save` and `kitchen.close`. The screens show them as they
 * stand. The docket sentence ("Docket not found. …") is the orders module's
 * (`DOCKET_NOT_FOUND_MESSAGE`), the list sentences are in
 * `src/common/command-lines.ts`, and the reason sentence is in
 * `src/common/admin-reason.ts`.
 */

/** `kitchen.save`: a date that is not a real `YYYY-MM-DD` day (400). */
export const KITCHEN_DATE_MESSAGE = 'Enter a valid kitchen date.';

/** `kitchen.save`: a date after today in Lagos (400). */
export const KITCHEN_FUTURE_MESSAGE =
  'A kitchen entry cannot be dated in the future.';

/** `kitchen.save` by a non-manager naming a date other than the docket's (400). */
export const KITCHEN_DATE_ASSIGNED_MESSAGE =
  'Kitchen date is assigned by the system.';

/** `kitchen.save` by a non-manager naming a revision other than the docket's (400). */
export const KITCHEN_REVISION_ASSIGNED_MESSAGE =
  'Docket revision is assigned by the system.';

/** `kitchen.save` by a non-manager naming an order other than the docket's (400). */
export const KITCHEN_ORDER_ASSIGNED_MESSAGE =
  'Restaurant order is assigned by the system.';

/** `kitchen.save` whose lines are not a list (400). */
export const KITCHEN_LINES_MESSAGE = 'Enter kitchen portions.';

/** `kitchen.save` creating a second entry for one docket (409). */
export const KITCHEN_DUPLICATE_MESSAGE =
  'This docket already exists. Edit its existing kitchen entry.';

/** `kitchen.save` naming a stock item that is missing or not a Kitchen item (400). */
export const KITCHEN_PORTION_MESSAGE = 'Select a kitchen portion.';

/** `kitchen.close` for any day but today in Lagos (400). */
export const KITCHEN_CLOSE_TODAY_MESSAGE =
  'Only the current kitchen day can be closed.';

/** `kitchen.close` a second time (409). */
export const KITCHEN_CLOSED_MESSAGE = 'This kitchen day is already closed.';

/**
 * `kitchen.save` naming a `version` for a docket that has no entry (404).
 * New: in the demo an id that matched nothing was read as a new entry; on
 * the server `version` is what says "edit", and an edit of nothing is
 * refused rather than turned into a create.
 */
export const KITCHEN_ENTRY_NOT_FOUND_MESSAGE = 'Kitchen entry not found.';
