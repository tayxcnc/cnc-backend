/**
 * The till's sentences for orders, lines and dockets, byte for byte from
 * `staff/lib/domain.ts` (`order.create`, `order.quantity`, `order.details`,
 * `order.confirm`, `kitchen.save`'s docket lookup), because the screens show
 * them as they stand (A7). Copied from the domain, never retyped.
 *
 * The payment, settlement and correction sentences (`order.payment`,
 * `partPay`, `settle`, `discount`, `cancel`, `reopen`, `reverse`, card
 * C4-5) follow them below.
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

// ---------------------------------------------------------------------------
// Payment, settlement and the corrections (card C4-5): `order.payment`,
// `order.partPay`, `order.settle`, `order.discount`, `order.cancel`,
// `order.reopen` and `order.reverse`, byte for byte from the domain.
// ---------------------------------------------------------------------------

/** `order.payment` on a bill that is not open (409). */
export const PAYMENT_OPEN_MESSAGE = 'Only open orders can proceed to payment.';

/** `order.payment` on a bill with no lines (409). */
export const PAYMENT_EMPTY_MESSAGE = 'Add at least one item.';

/**
 * `order.payment` on a Restaurant bill whose lines differ from its latest
 * docket (409): the kitchen must have what the guest pays for.
 */
export const PAYMENT_CONFIRM_FIRST_MESSAGE =
  'Confirm the latest food items and print the kitchen docket first.';

/** `order.partPay` on a bill that is not awaiting payment (409). */
export const PART_PAY_STAGE_MESSAGE =
  'Proceed to payment before taking a part payment.';

/** `order.partPay` and `order.settle` without a list of payments (400). */
export const PAYMENT_MISSING_MESSAGE = 'Payment information is missing.';

/** `order.partPay` whose sum is nothing, or the whole balance or more (400). */
export const PART_PAY_LESS_MESSAGE =
  'A part payment must be less than the balance. Use settlement for the full balance.';

/** A payment of zero, a negative or a fraction of a kobo (400). */
export const PAYMENT_POSITIVE_MESSAGE = 'Payment amounts must be positive.';

/** A payment method other than Cash, Card or Transfer at the till (400). */
export const PAYMENT_METHOD_MESSAGE = 'Invalid payment method.';

/** A transfer without its sender or reference (400). */
export const TRANSFER_DETAILS_MESSAGE =
  'Transfer payments require the sender name and reference.';

/**
 * `order.settle` on a bill that is not awaiting payment (409), including a
 * second settle of a bill already settled.
 */
export const SETTLE_STAGE_MESSAGE =
  'Proceed to payment before settlement. This order may already be settled.';

/** `order.settle` whose payments do not equal the balance to the kobo (400). */
export const SETTLE_EXACT_MESSAGE =
  'Payment amounts must exactly cover the remaining balance.';

/**
 * `order.settle` with a deposit credit that is not a whole amount, or more
 * than is left to pay (400).
 */
export const DEPOSIT_INVALID_MESSAGE = 'Invalid deposit credit.';

/**
 * `order.settle` taking deposit credit from a booking that is not checked
 * in (or completed) at this bill's table (400).
 */
export const DEPOSIT_RESERVATION_MESSAGE =
  'Choose a checked-in reservation for this table.';

/** `order.settle` taking more deposit credit than the booking has left (409). */
export const DEPOSIT_USED_MESSAGE =
  'That deposit credit has already been used.';

/** `order.discount` after Proceed to Payment or on a carried bill (409). */
export const DISCOUNT_STAGE_MESSAGE =
  'Discounts must be applied before proceeding to payment on the opening date.';

/** `order.discount` that is not a whole amount up to the subtotal (400). */
export const DISCOUNT_INVALID_MESSAGE = 'Invalid discount.';

/** `order.cancel` on a settled or cancelled bill (409). */
export const CANCEL_STAGE_MESSAGE = 'Only unpaid bills can be cancelled.';

/** `order.cancel` on a bill that has money against it (409). */
export const CANCEL_PART_PAID_MESSAGE =
  'This bill has part payments. Settle the balance instead of cancelling.';

/** `order.reopen` on a bill that is not awaiting payment (409). */
export const REOPEN_STAGE_MESSAGE =
  'Only orders awaiting payment can be reopened here.';

/** `order.reopen` on a bill from an earlier business date (409). */
export const REOPEN_PREVIOUS_DAY_MESSAGE =
  'Previous-day items remain locked. Create a new order for new items.';

/** `order.reverse` on a bill that is not a settled till bill (409). */
export const REVERSE_STAGE_MESSAGE = 'Select a settled POS order.';

/**
 * The most payments one request records. New: the demo had no cap. A split
 * at the till is two or three rows; the cap keeps one request from drawing
 * thousands of payment numbers.
 */
export const MAX_PAYMENTS_PER_REQUEST = 20;

/** The refusal past {@link MAX_PAYMENTS_PER_REQUEST}. New, in the demo's form. */
export const TOO_MANY_PAYMENTS_MESSAGE = `Record at most ${MAX_PAYMENTS_PER_REQUEST} payments at once.`;

/** Longest transfer sender name and payment reference accepted. */
export const PAYMENT_TEXT_MAX_LENGTH = 120;

/** Longest table label, guest name and order note accepted. */
export const ORDER_LABEL_MAX_LENGTH = 80;
export const ORDER_GUEST_MAX_LENGTH = 120;
export const ORDER_NOTES_MAX_LENGTH = 500;
