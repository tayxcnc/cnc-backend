import {
  AddressZone,
  Department,
  Fulfilment,
  OnlineOrderMode,
} from '../../generated/cnc-client';
import type { PricedLine } from '../ordering/cart-pricing';
import { docketItem, type DocketItem } from '../orders/docket-items';

/**
 * What a paid web order is made of (plan §7.4 step 4, card C7-3), as pure
 * functions, so the one transaction that writes it and the tests that
 * check it read a checkout the same way.
 */

/**
 * The staff app's delivery mode for a checkout's fulfilment and zone:
 * pickup, delivery within Jos (`JOS`), or outside Jos (`PLATEAU`).
 */
export function onlineOrderMode(
  fulfilment: Fulfilment,
  zone: AddressZone | null,
): OnlineOrderMode {
  if (fulfilment === Fulfilment.PICKUP) return OnlineOrderMode.PICKUP;

  return zone === AddressZone.PLATEAU
    ? OnlineOrderMode.OUTSIDE_JOS
    : OnlineOrderMode.WITHIN_JOS;
}

/**
 * The web docket's items: the **Restaurant lines only**, in the cart's
 * order (plan §7.4 step 4: drinks are not sent to the kitchen). Empty for
 * a cart of drinks alone, which then gets no docket.
 */
export function webDocketItems(lines: readonly PricedLine[]): DocketItem[] {
  return lines
    .filter((line) => line.department === Department.RESTAURANT)
    .map((line) => docketItem(line));
}

/** One Bar movement a paid web order makes. */
export interface WebSaleMove {
  stockItemId: string;
  /** The servings sold: the sum of the drink's lines (every option). */
  qty: number;
}

/** What the Bar movements of a paid web order are. */
export interface WebSalePlan {
  /** One per paired stock item, in stock-item id order. */
  moves: WebSaleMove[];
  /** Drinks sold that have no paired Bar stock item, in cart order. */
  unpaired: string[];
}

/**
 * The Bar movements for a paid web order's drinks (plan §7.4 step 4), as
 * a Bar settlement makes them (*Payments, settlement and bill
 * corrections*): one movement per paired stock item by the sum of its
 * lines, in stock-item id order, so two orders sharing drinks take their
 * balance locks in one order and cannot deadlock.
 *
 * A drink with no paired stock item is named in `unpaired` and moves
 * nothing. The till refuses such a settlement; a web order cannot be
 * refused, because the money is already taken (§7.4), so the order is
 * written and the gap is logged for a person.
 */
export function webSalePlan(
  lines: readonly PricedLine[],
  pairedStockItemByMenuItem: ReadonlyMap<string, string>,
): WebSalePlan {
  const qtyByStockItem = new Map<string, number>();
  const unpaired: string[] = [];

  for (const line of lines) {
    if (line.department !== Department.BAR) continue;

    const stockItemId = pairedStockItemByMenuItem.get(line.menuItemId);

    if (stockItemId === undefined) {
      if (!unpaired.includes(line.name)) unpaired.push(line.name);
      continue;
    }

    qtyByStockItem.set(
      stockItemId,
      (qtyByStockItem.get(stockItemId) ?? 0) + line.qty,
    );
  }

  const moves = [...qtyByStockItem.entries()]
    .map(([stockItemId, qty]) => ({ stockItemId, qty }))
    .sort((a, b) =>
      a.stockItemId < b.stockItemId
        ? -1
        : a.stockItemId > b.stockItemId
          ? 1
          : 0,
    );

  return { moves, unpaired };
}
