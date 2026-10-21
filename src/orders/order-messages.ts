/**
 * The till's sentences for orders, lines and dockets, byte for byte from
 * `staff/lib/domain.ts` (`order.create`, `order.quantity`, `order.details`,
 * `order.confirm`, `kitchen.save`'s docket lookup), because the screens show
 * them as they stand (A7). Copied from the domain, never retyped.
 *
 * The payment, settlement and correction sentences (`order.payment`,
 * `partPay`, `settle`, `discount`, `cancel`, `reopen`, `reverse`) belong to
 * card C4-5 and are added beside these.
 */

/** `order()`: the order named does not exist (404). */
export const ORDER_NOT_FOUND_MESSAGE = 'Order not found.';

/** A Bartender reaching a Restaurant order or department (403). */
export const BAR_POS_ONLY_MESSAGE = 'Bartenders can operate Bar POS only.';

/** `order.create` without Restaurant or Bar (400). */
export const DEPARTMENT_MESSAGE = 'Choose a department.';

/** `order.create` naming a table that does not exist (400). */
export const TABLE_MESSAGE = 'Select a valid table.';

/** `order.quantity`: a quantity that is not a whole number of 0 or more. */
export const QTY_WHOLE_MESSAGE = 'Enter a whole number zero or above.';

/** `order.quantity`: above the line maximum (a CHECK holds it too). */
export const QTY_MAX_MESSAGE = 'Maximum item quantity is 999.';

/** The largest quantity one line may hold. */
export const MAX_LINE_QTY = 999;

/**
 * `order.quantity`: the dish is not on the menu, belongs to the other
 * department, or is not Available for Sale (removing a line is allowed
 * whatever the dish's state).
 */
export const ITEM_UNAVAILABLE_MESSAGE =
  'This item is unavailable in the selected department.';

/** `order.quantity`: an option sent for a dish that has none. */
export const NO_OPTIONS_MESSAGE = 'This item has no options.';

/**
 * `order.quantity`: a dish with a choice needs one of its options, "Choose
 * style for Pancakes." The label is lower-cased, as the demo does.
 */
export function chooseOptionMessage(
  choiceLabel: string,
  itemName: string,
): string {
  return `Choose ${choiceLabel.toLowerCase()} for ${itemName}.`;
}

/** `allowOrder`: an open order from an earlier business date (409). */
export const PREVIOUS_DAY_MESSAGE =
  'This order belongs to a previous day. Create a new order to add items.';

/** `allowOrder`: an order that is not open (409). */
export const ORDER_LOCKED_MESSAGE =
  'This order is locked. A manager must reopen it before editing.';

/** `order.confirm` on an order that is not open (409). */
export const CONFIRM_OPEN_MESSAGE = 'Only open orders can be confirmed.';

/** `order.confirm` with no lines (409). */
export const CONFIRM_EMPTY_MESSAGE = 'Add items before confirming.';

/** `order.confirm` on a Bar order (409). */
export const BAR_NO_DOCKETS_MESSAGE = 'Bar orders do not use kitchen dockets.';

/**
 * A docket ref nobody printed (404): the Kitchen screen's lookup, the
 * demo's `kitchen.save` sentence.
 */
export const DOCKET_NOT_FOUND_MESSAGE =
  'Docket not found. Enter the kitchen docket number printed by Restaurant POS.';

/** Longest table label, guest name and order note accepted. */
export const ORDER_LABEL_MAX_LENGTH = 80;
export const ORDER_GUEST_MAX_LENGTH = 120;
export const ORDER_NOTES_MAX_LENGTH = 500;
