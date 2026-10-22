import { StockLocation } from '../../generated/cnc-client';

/**
 * The stock commands' sentences, byte for byte from `staff/lib/domain.ts`
 * (A7): `move`, `stock.issue`, `stock.count`, `stock.adjust`,
 * `stockitem.create`, `stockitem.save` and `mapping.save`. The screens show
 * them as they stand. The list sentences (`positiveLines`) are in
 * `src/common/command-lines.ts`, the reason sentence in
 * `src/common/admin-reason.ts`, the Owner and limit sentences in
 * `MoneyControlService`.
 */

/** A stock item id that names nothing (404). */
export const STOCK_ITEM_NOT_FOUND_MESSAGE = 'Stock item not found.';

/**
 * A stock item, or a new Bar item's paired stock item, whose name another
 * stock item already holds, ignoring case (409).
 */
export const STOCK_ITEM_EXISTS_MESSAGE = 'This stock item already exists.';

/**
 * The demo's `move` refusal: a decrement that would take a balance below
 * zero (409, a state conflict). "Insufficient kitchen stock for Rice."
 */
export function insufficientStockMessage(
  location: StockLocation,
  itemName: string,
): string {
  return `Insufficient ${location.toLowerCase()} stock for ${itemName}.`;
}

/** `stock.issue`: a destination other than the Kitchen or the Bar. */
export const ISSUE_LOCATION_MESSAGE = 'Choose Kitchen or Bar.';

/** `stock.issue`: no item, or one the destination does not hold. */
export const ISSUE_ITEM_MESSAGE = 'Select an item for this stock location.';

/** `stock.issue` and `stock.adjust`: a quantity that is not whole and above zero. */
export const WHOLE_ABOVE_ZERO_MESSAGE = 'Enter a whole number above zero.';

/** `stock.count` and `stock.adjust`: no location, or an unknown one. */
export const STOCK_LOCATION_MESSAGE = 'Choose a stock location.';

/** `stock.count` by anyone but a manager, or the storekeeper at the Store (403). */
export const COUNT_ROLE_MESSAGE =
  'Only the storekeeper counts the store. Managers count any location.';

/** `stock.count` with no figures. */
export const COUNT_EMPTY_MESSAGE = 'Enter at least one counted figure.';

/** `stock.count` with a figure that is not a whole number of zero or more. */
export const COUNT_WHOLE_MESSAGE =
  'Counted figures must be whole numbers of zero or more.';

/** `stock.adjust` (and, on the server, `stock.count`): an item the location does not hold. */
export const LOCATION_ITEM_MESSAGE = 'Choose an item for this location.';

/**
 * `stock.adjust` with no direction. New: the demo read a missing direction
 * as a signed quantity, and the API takes the direction the screen always
 * sends.
 */
export const ADJUST_DIRECTION_MESSAGE = 'Choose Add or Remove.';

/** `stockitem.create`: a blank name, unit or pack. */
export const ITEM_NAME_UNITS_MESSAGE = 'Enter an item name and units.';

/** `stockitem.create`: a conversion or reorder level that is not whole. */
export const ITEM_CONVERSION_MESSAGE =
  'Enter a whole conversion above zero and a non-negative minimum.';

/** `stockitem.save`: blank units, or a conversion or reorder level that is not whole. */
export const ITEM_UNITS_MESSAGE =
  'Enter units, a whole conversion above zero and a non-negative minimum.';

/** `mapping.save`: a menu item that is missing or not a Restaurant item. */
export const MAPPING_FOOD_MESSAGE = 'Choose a food menu item.';

/** `mapping.save`: a stock item that is missing or not a Kitchen item. */
export const MAPPING_PORTION_MESSAGE = 'Choose a kitchen portion.';

/** Longest stock item name, unit or pack accepted; new (the demo has none). */
export const STOCK_TEXT_MAX_LENGTH = 120;

/** Longest note on a direct issue; new. */
export const STOCK_NOTE_MAX_LENGTH = 500;
