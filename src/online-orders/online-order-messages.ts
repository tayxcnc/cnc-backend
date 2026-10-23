/**
 * The Online Orders sentences (plan §5.4, card C7-4), byte for byte from
 * `staff/lib/domain.ts` (`online.status`, `online.correctStatus`,
 * `online.edit`, `online.cancel`, `online.zone`, `online.balance`),
 * because the screen shows them as they stand (A7). Each sentence the demo
 * never had is marked new, with why.
 */

/** `online.balance`: the online order named does not exist (404). */
export const ONLINE_ORDER_NOT_FOUND_MESSAGE = 'Online order not found.';

/** `online.status` on a completed or cancelled order (409). */
export const ONLINE_ORDER_CLOSED_MESSAGE = 'This online order is closed.';

/**
 * `online.status` to anything but the current stage or the next one on
 * the order's own path (409): going back is a manager's correction.
 */
export const NEXT_STAGE_MESSAGE =
  'Move to the next fulfilment stage. Earlier statuses need a manager correction.';

/**
 * `online.status` and `online.correctStatus` to Completed while money is
 * still owed either way (409).
 */
export const OUTSTANDING_BALANCE_MESSAGE =
  'Record the outstanding payment or refund before completing this order.';

/** `online.correctStatus` on a cancelled order (409). */
export const SELECT_ONLINE_ORDER_MESSAGE = 'Select an online order.';

/** `online.correctStatus` to a status that is not a fulfilment stage (400). */
export const INVALID_FULFILMENT_STATUS_MESSAGE = 'Invalid fulfilment status.';

/**
 * `online.correctStatus` to Ready for Pickup on a delivery, or Out for
 * Delivery on a pickup (400); also Delivered on a pickup and Collected on a
 * delivery, the two words the server stores for the demo's one Completed.
 */
export const STATUS_MODE_MESSAGE = 'Status does not match the delivery method.';

/**
 * `online.edit` and `online.cancel` on a cancelled order (409), and, by
 * Q8's default ("any time before Completed"), on a completed one.
 */
export const SELECT_ACTIVE_ONLINE_ORDER_MESSAGE =
  'Select an active online order.';

/**
 * `online.edit` naming a dish that is not on the menu (400). The demo's
 * "Choose a Restaurant menu item." named the Restaurant because its editor
 * offered food only; D30 lets a manager edit the drinks too, so the
 * sentence names both. New in that one word.
 */
export const EDIT_MENU_ITEM_MESSAGE = 'Choose a Restaurant or Bar menu item.';

/** `online.edit`: a dish with no choice sent with an option (400). */
export function noOptionsMessage(itemName: string): string {
  return `${itemName} has no options.`;
}

/** `online.zone` once the order has left or is ready (409). */
export const ZONE_BEFORE_DISPATCH_MESSAGE =
  'The delivery zone can only change before dispatch.';

/** `online.zone` to something other than the three modes (400). */
export const INVALID_ZONE_MESSAGE = 'Invalid delivery zone.';

/** `online.zone` to a delivery with no address sent or held (400). */
export const DELIVERY_ADDRESS_MESSAGE = 'Enter a delivery address.';

/** `online.balance` when the order owes and is owed nothing (409). */
export const NO_ADJUSTMENT_MESSAGE = 'No payment adjustment is outstanding.';

/** `online.balance` with a method that is not offered (400). */
export const BALANCE_METHOD_MESSAGE = 'Choose a payment method.';

/** `online.balance` by transfer without both parties' details (400). */
export const BALANCE_TRANSFER_MESSAGE =
  'Transfers require a sender/recipient and reference.';

/**
 * `online.balance` naming Paystack for extra money the customer owes
 * (400). New: Q34's default takes extra money as Cash or Transfer
 * recorded by staff, with no payment link at launch.
 */
export const EXTRA_MONEY_METHOD_MESSAGE =
  'Record extra money from the customer as Cash or Transfer.';

/**
 * `online.balance` asking Paystack to refund more than the card paid and
 * has not yet had back (409). New: Paystack refunds a transaction only up
 * to its amount, and extra money taken in cash cannot go back to a card.
 */
export const CARD_REFUND_LIMIT_MESSAGE =
  'A card refund cannot be more than the card payment not yet refunded. Record the rest as Cash or Transfer.';

/**
 * Paystack refused the refund (502). New. Its payment is reversed, so the
 * refund is owed again and a manager can record it another way.
 */
export const REFUND_REFUSED_MESSAGE =
  'Paystack refused the refund, so nothing was sent. Record the refund as Cash or Transfer instead.';

/**
 * Paystack's answer to a refund did not arrive (503). New. Paystack may
 * have queued it, so it stays recorded and is never sent again on its
 * own: a second request could return the money twice.
 */
export const REFUND_UNCONFIRMED_MESSAGE =
  'We could not confirm the refund with Paystack. Check the Paystack dashboard, then resolve the refund as sent or not sent.';

/**
 * Resolving a card refund with an outcome that is not one of the two
 * (400). New: a refund left unconfirmed is resolved by what the Paystack
 * dashboard shows.
 */
export const REFUND_OUTCOME_MESSAGE =
  'Choose whether the Paystack dashboard shows the refund.';

/** Resolving a refund as sent without Paystack's refund id (400). New. */
export const REFUND_ID_MESSAGE =
  'Enter the refund id the Paystack dashboard shows.';

/** Resolving a refund this order does not have (404). New. */
export const REFUND_NOT_FOUND_MESSAGE = 'Refund not found.';

/**
 * Resolving a refund that was answered, or is still being sent (409).
 * New: only a refund whose answer never arrived needs a person, and one
 * still in flight may yet be answered.
 */
export const REFUND_NOT_UNCONFIRMED_MESSAGE =
  'Only a card refund Paystack has not confirmed can be resolved.';

/** Resolving a held checkout that does not exist (404). New. */
export const HELD_CHECKOUT_NOT_FOUND_MESSAGE = 'Checkout not found.';

/**
 * Resolving a checkout that is not held (409): paid, already resolved,
 * or never held. New.
 */
export const CHECKOUT_NOT_HELD_MESSAGE =
  'This checkout is not waiting for attention.';

/**
 * A card refund asked for while CNC's Paystack key is unset or a
 * placeholder (503). New, in the form of the checkout's own sentence;
 * nothing is recorded.
 */
export const CARD_REFUNDS_UNAVAILABLE_MESSAGE =
  'Card refunds are not available just now. Record the refund as Cash or Transfer.';

/**
 * `GET /me/orders/:number` for an order that is not the customer's, or
 * none (404, C7-6): the account app's own sentence
 * (`components/account/panels.tsx`), byte for byte, so another
 * customer's order reads as no order at all.
 */
export const CUSTOMER_ORDER_NOT_FOUND_MESSAGE =
  'We could not find that order on this account.';

/** Longest guest name kept on an online order (the checkout's). */
export const ONLINE_CONTACT_NAME_MAX_LENGTH = 80;
