/**
 * The waste sentences, byte for byte from `staff/lib/domain.ts` (A7):
 * `waste.create`, `waste.edit`, `waste.status`, `waste.approve` and
 * `waste.reject`. The screens show them as they stand. The location
 * sentence is the stock core's (`STOCK_LOCATION_MESSAGE`), the reason
 * sentence `src/common/admin-reason.ts`'s, the limit and own-record
 * sentences `MoneyControlService`'s. Sentences marked new have no demo
 * original.
 */

/** `waste.create` by a Kitchen user for another location (403). */
export const KITCHEN_WASTE_ONLY_MESSAGE =
  'Kitchen staff can log kitchen waste only.';

/** `waste.create` by a Bartender or a Cashier for another location (403). */
export const BAR_WASTE_ONLY_MESSAGE =
  'Bar and cashier staff can log bar waste only.';

/** `waste.create` by the Storekeeper for another location (403). */
export const STORE_WASTE_ONLY_MESSAGE = 'Store staff can log store waste only.';

/** `waste.create`: a quantity that is not whole and above zero, or no waste reason. */
export const CREATE_QTY_REASON_MESSAGE =
  'Enter a whole quantity and a waste reason.';

/** `waste.create`: no item, or one the location does not hold. */
export const CREATE_ITEM_MESSAGE = 'Select a stock item for this location.';

/** `waste.edit`, and on the server every waste command: an id that names nothing (404). */
export const WASTE_NOT_FOUND_MESSAGE = 'Waste record not found.';

/** `waste.edit`: no location, no item, or an item the location does not hold. */
export const EDIT_ITEM_MESSAGE = 'Choose an item for this stock location.';

/** `waste.edit`: the same quantity and reason check, in the edit's own words. */
export const EDIT_QTY_REASON_MESSAGE =
  'Enter a whole quantity and waste reason.';

/** `waste.status`: a status that is not Pending, Approved or Rejected. */
export const WASTE_STATUS_MESSAGE = 'Select a waste record and valid status.';

/** `waste.approve` and `waste.reject` on an entry that is not Pending (409). */
export const REVIEW_PENDING_WASTE_MESSAGE =
  'Only pending waste can be reviewed.';

/** A waste filter naming an unknown view (400). New. */
export const WASTE_VIEW_MESSAGE = 'Choose Pending, History or All.';

/** Longest note on a waste entry; new (the stock core's note length). */
export const WASTE_NOTE_MAX_LENGTH = 500;
