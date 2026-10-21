/**
 * The `menu.save` sentences. The first two are byte for byte from
 * `staff/lib/domain.ts` (A7); the Owner-only price and new-item sentences
 * are `MoneyControlService`'s. The rest are new: the demo filed an unknown
 * category under "Other" and had no ids to look up.
 */

/** A blank name, or a price that is not a whole number above zero. */
export const MENU_NAME_PRICE_MESSAGE = 'Enter an item name and positive price.';

/** A department that is not Restaurant or Bar. */
export const MENU_DEPARTMENT_MESSAGE = 'Choose a department.';

/** A staff category that does not exist or belongs to the other department. */
export const MENU_CATEGORY_MESSAGE =
  "Choose a category from the item's department.";

/** A menu item id that names nothing (404). */
export const MENU_ITEM_NOT_FOUND_MESSAGE = 'Menu item not found.';

/**
 * A new Bar item whose paired stock item would take a name another stock
 * item already holds, ignoring case (409). The demo's `stockitem.create`
 * sentence: it is the same clash.
 */
export const STOCK_ITEM_EXISTS_MESSAGE = 'This stock item already exists.';

/** Longest dish name accepted. */
export const MENU_NAME_MAX_LENGTH = 120;

/** Longest description accepted. */
export const MENU_DESCRIPTION_MAX_LENGTH = 1000;

/** Longest photo alternative text accepted. */
export const MENU_PHOTO_ALT_MAX_LENGTH = 200;
