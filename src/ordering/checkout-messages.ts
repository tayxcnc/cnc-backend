/**
 * The order page's sentences (C7-1). Where the website's checkout already
 * says something (`components/order/OrderApp.tsx`), the server says it
 * byte for byte (A7); each sentence it never had is marked new, with why.
 */

/** An empty cart. The website's cart drawer, byte for byte. */
export const CART_EMPTY_MESSAGE =
  'Your order is empty. Add dishes from the menu.';

/**
 * A cart that is not a list of `{ dishId, option?, qty }`, or longer than
 * `CART_MAX_LINES`. New: the website builds its own lines.
 */
export const CART_LINES_MESSAGE = 'Check the dishes in your order.';

/** A quantity outside 1 to 999 (the bill's own range). New. */
export const CART_QTY_MESSAGE =
  'Choose a quantity from 1 to 999 for each dish.';

/**
 * A dish that is not on the online menu now: unknown, not Available for
 * Sale, or not Show Online (Q37 hides it). New: the website drops such a
 * line when it loads the cart, so only a cart kept open across a menu
 * change meets it.
 */
export const DISH_UNAVAILABLE_MESSAGE =
  'One of the dishes in your order is no longer available. Remove it and try again.';

/**
 * A dish with a choice sent without one of its options, or a dish without
 * a choice sent with one. New: the website's choice dialog always picks.
 */
export function choiceMessage(dishName: string): string {
  return `Choose one of the options for ${dishName}.`;
}

/** The address lines, the website's sentences byte for byte. */
export const STREET_MESSAGE = 'Add the street address.';
export const AREA_MESSAGE = 'Add the area or neighbourhood.';
export const TOWN_MESSAGE = 'Add the town.';

/** The details step, the website's sentences byte for byte. */
export const CHECKOUT_NAME_MESSAGE = 'Add your name.';
export const CHECKOUT_EMAIL_MISSING_MESSAGE = 'Add your email for the receipt.';
export const CHECKOUT_EMAIL_INVALID_MESSAGE = 'Check the email address.';
export const CHECKOUT_TIME_MESSAGE = 'Choose a time.';

/**
 * A timing that is neither `ASAP` nor `SCHEDULED`. New: the website offers
 * two buttons.
 */
export const CHECKOUT_TIMING_MESSAGE = 'Choose as soon as possible or a time.';

/**
 * As soon as possible chosen when it is not offered (CNC closed, or now
 * plus the lead passes the last order slot). New: the website switches to
 * a time by itself, so only a page left open past the moment meets it.
 */
export const ASAP_UNAVAILABLE_MESSAGE =
  'As soon as possible is not available just now. Choose a time.';

/** A `saveDetails` that is not true or false. New. */
export const SAVE_DETAILS_MESSAGE = 'Choose whether to save your details.';

/** `GET /checkouts/:reference` for a reference no checkout holds (404). New. */
export const CHECKOUT_NOT_FOUND_MESSAGE = 'We could not find that order.';

/**
 * The warning beside a drink the Bar holds fewer of than the cart asks for
 * (plan §7.4: warn, never refuse; the money is taken first and stock
 * never blocks a paid order). New.
 */
export function shortDrinkWarning(dishName: string): string {
  return `We may be short of ${dishName} at the bar. If it runs out, we will call you before your order is ready.`;
}
