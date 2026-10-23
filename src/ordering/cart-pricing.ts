import { Department } from '../../generated/cnc-client';
import { orderTotals } from '../orders/order-totals';
import {
  CART_EMPTY_MESSAGE,
  CART_LINES_MESSAGE,
  CART_QTY_MESSAGE,
  DISH_UNAVAILABLE_MESSAGE,
  choiceMessage,
} from './checkout-messages';

/**
 * Pricing a web cart on the server (plan §7.4 step 2, C7-1): every line is
 * priced from the menu as it stands, never from the browser, with the
 * website's arithmetic (`lib/order/checkout.ts` `totals`): VAT on the
 * subtotal, rounded to the kobo, plus the zone's delivery fee. **Q33:
 * nothing is added for Paystack's charge**; CNC absorbs it, so the total
 * is subtotal + VAT + delivery. Pure, so the quote and the checkout price
 * one cart one way.
 */

/** The most lines a cart may carry (the website's menu has 166 dishes). */
export const CART_MAX_LINES = 100;

/** The largest quantity of one line: the bill's own range (OrderLine CHECK). */
export const CART_MAX_QTY = 999;

/** One cart line as the request sends it. */
export interface CartLineInput {
  dishId: string;
  option?: string;
  qty: number;
}

/** A menu item as pricing reads it. */
export interface PricingMenuItem {
  id: string;
  slug: string;
  name: string;
  priceKobo: number;
  department: Department;
  active: boolean;
  showOnline: boolean;
  choiceOptions: string[];
}

/** A priced line, as a checkout stores it (`Checkout.lines`). */
export interface PricedLine {
  menuItemId: string;
  dishId: string;
  name: string;
  /** `''` for a dish without a choice, as an order line stores it. */
  option: string;
  qty: number;
  unitPriceKobo: number;
  department: Department;
}

/** A priced cart's money, every figure in kobo. */
export interface CartSums {
  subtotalKobo: number;
  vatKobo: number;
  deliveryKobo: number;
  totalKobo: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The request's `lines` field's one sentence, or null: a non-empty list,
 * at most `CART_MAX_LINES`, of `{ dishId: text, option?: text, qty }` with
 * every quantity a whole number from 1 to 999. Whether each dish exists is
 * `priceCart`'s, against the menu.
 */
export function cartLinesProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return CART_LINES_MESSAGE;

  if (value.length === 0) return CART_EMPTY_MESSAGE;

  if (value.length > CART_MAX_LINES) return CART_LINES_MESSAGE;

  for (const line of value) {
    if (
      !isRecord(line) ||
      typeof line.dishId !== 'string' ||
      line.dishId.trim() === '' ||
      line.dishId.length > 120 ||
      (line.option !== undefined &&
        line.option !== null &&
        typeof line.option !== 'string')
    ) {
      return CART_LINES_MESSAGE;
    }
  }

  for (const line of value as Record<string, unknown>[]) {
    const qty = line.qty;

    if (
      typeof qty !== 'number' ||
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > CART_MAX_QTY
    ) {
      return CART_QTY_MESSAGE;
    }
  }

  return null;
}

/** The slugs a cart names, for the one menu read that prices it. */
export function cartSlugs(lines: readonly CartLineInput[]): string[] {
  return [...new Set(lines.map((line) => line.dishId.trim()))];
}

/**
 * Price a cart that `cartLinesProblem` passed, against the menu items its
 * slugs name. Answers the priced lines in the cart's order, or the first
 * line's sentence: a dish not on the online menu now, then a choice that
 * is not one of the dish's options. Two lines of one dish and option are
 * one line, as the website and a bill keep them; their sum must stay
 * within 999.
 */
export function priceCart(
  lines: readonly CartLineInput[],
  items: ReadonlyMap<string, PricingMenuItem>,
): { lines: PricedLine[] } | { problem: string } {
  const priced = new Map<string, PricedLine>();

  for (const line of lines) {
    const item = items.get(line.dishId.trim());

    if (item === undefined || !item.active || !item.showOnline) {
      return { problem: DISH_UNAVAILABLE_MESSAGE };
    }

    const option = (line.option ?? '').trim();
    const choiceIsRight =
      item.choiceOptions.length === 0
        ? option === ''
        : item.choiceOptions.includes(option);

    if (!choiceIsRight) return { problem: choiceMessage(item.name) };

    const key = `${item.id}\u0000${option}`;
    const existing = priced.get(key);

    if (existing !== undefined) {
      existing.qty += line.qty;

      if (existing.qty > CART_MAX_QTY) return { problem: CART_QTY_MESSAGE };
    } else {
      priced.set(key, {
        menuItemId: item.id,
        dishId: item.slug,
        name: item.name,
        option,
        qty: line.qty,
        unitPriceKobo: item.priceKobo,
        department: item.department,
      });
    }
  }

  return { lines: [...priced.values()] };
}

/**
 * A priced cart's sums: the website's `totals`, through the bill's own
 * `orderTotals` with no service, discount or deposit (a web order has
 * none), plus the delivery fee.
 */
export function cartSums(
  lines: readonly PricedLine[],
  vatBps: number,
  deliveryKobo: number,
): CartSums {
  const bill = orderTotals({
    lines,
    vatBps,
    serviceBps: 0,
    discountKobo: 0,
    depositKobo: 0,
  });

  return {
    subtotalKobo: bill.subtotalKobo,
    vatKobo: bill.vatKobo,
    deliveryKobo,
    totalKobo: bill.totalKobo + deliveryKobo,
  };
}

function isPricedLine(value: unknown): value is PricedLine {
  if (!isRecord(value)) return false;

  return (
    typeof value.menuItemId === 'string' &&
    typeof value.dishId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.option === 'string' &&
    typeof value.qty === 'number' &&
    Number.isInteger(value.qty) &&
    typeof value.unitPriceKobo === 'number' &&
    Number.isInteger(value.unitPriceKobo) &&
    (value.department === Department.RESTAURANT ||
      value.department === Department.BAR)
  );
}

/**
 * `Checkout.lines` read back from `jsonb`, checked rather than cast, as
 * `parseDocketItems` reads a docket. The confirmation page and the order
 * a payment creates (C7-3) both read it here: a row in a shape this
 * service did not write fails loudly instead of creating an order with a
 * dish missing from what the customer paid for.
 */
export function parseCheckoutLines(value: unknown): PricedLine[] {
  if (!Array.isArray(value) || !value.every(isPricedLine)) {
    throw new Error(
      'A checkout holds lines in a shape this service cannot read.',
    );
  }

  return value.map((line) => ({
    menuItemId: line.menuItemId,
    dishId: line.dishId,
    name: line.name,
    option: line.option,
    qty: line.qty,
    unitPriceKobo: line.unitPriceKobo,
    department: line.department,
  }));
}
