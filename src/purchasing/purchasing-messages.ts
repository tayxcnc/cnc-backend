/**
 * The purchasing and vendor sentences, byte for byte from
 * `staff/lib/domain.ts` (A7): `purchase.create`, `purchase.edit`,
 * `purchase.approve`, `purchase.reject`, `purchase.status`,
 * `purchase.receive`, `purchase.archive` and `vendor.save`. The screens show
 * them as they stand. The list sentences (`positiveLines`) are in
 * `src/common/command-lines.ts`, the reason sentence in
 * `src/common/admin-reason.ts`, the limit and own-record sentences in
 * `MoneyControlService`. Sentences marked new have no demo original.
 */

/** `purchase.create` and `purchase.edit`: a line whose vendor is missing or inactive. */
export const ACTIVE_VENDOR_MESSAGE = 'Choose an active vendor for every line.';

/** `purchase.create`: a line whose item is missing, or whose cost is not whole and above zero. */
export const CREATE_LINE_ITEM_COST_MESSAGE =
  'Choose a stock item and positive unit cost.';

/** `purchase.edit`: the same, in the edit's own words. */
export const EDIT_LINE_ITEM_COST_MESSAGE =
  'Choose an item and a positive unit cost.';

/** `purchase.edit` on an archived purchase (409). */
export const EDIT_ACTIVE_MESSAGE = 'Select an active purchase record.';

/** `purchase.archive` on an archived purchase (409). */
export const ARCHIVE_ACTIVE_MESSAGE = 'Purchase not found or already archived.';

/** `purchase.status` on a purchase with received goods, or an archived one (409). */
export const STATUS_LOCKED_MESSAGE =
  'Received or archived purchases cannot return to approval.';

/** `purchase.status` to Fulfilled, or to anything not a purchase status. */
export const STATUS_RECEIVE_MESSAGE =
  'Use Receive goods to record stock receipt.';

/** `purchase.approve` and `purchase.reject` on anything but an active Pending purchase (409). */
export const REVIEW_PENDING_MESSAGE =
  'Only active pending requisitions can be reviewed.';

/** `purchase.receive` on anything but an active Approved purchase (409). */
export const RECEIVE_APPROVED_MESSAGE = 'Receive only approved requisitions.';

/** `vendor.save` with a blank name or phone. */
export const VENDOR_NAME_PHONE_MESSAGE = 'Enter the vendor name and phone.';

/**
 * A purchase id that names nothing (404). New: the demo answered a missing
 * purchase with each command's state sentence; the version claim needs one
 * not-found sentence, in the form of "Stock request not found.".
 */
export const PURCHASE_NOT_FOUND_MESSAGE = 'Purchase not found.';

/** A vendor id that names nothing (404). New, in the same form. */
export const VENDOR_NOT_FOUND_MESSAGE = 'Vendor not found.';

/** A purchases filter naming an unknown view (400). New. */
export const PURCHASE_VIEW_MESSAGE = 'Choose Active or History.';

/** Longest procurement note, vendor address or vendor notes; new. */
export const PURCHASING_NOTE_MAX_LENGTH = 1000;

/** Longest vendor name, service, contact person or phone; new. */
export const VENDOR_TEXT_MAX_LENGTH = 120;

/** Longest vendor email; new (the longest address SMTP carries). */
export const VENDOR_EMAIL_MAX_LENGTH = 254;
