import {
  AddressZone,
  Department,
  Fulfilment,
  OnlineFulfilmentStatus,
  OnlineOrderMode,
} from '../../generated/cnc-client';
import type { PricedLine } from '../ordering/cart-pricing';
import { docketItem, type DocketItem } from '../orders/docket-items';
import { chooseOptionMessage } from '../orders/order-messages';
import {
  EDIT_MENU_ITEM_MESSAGE,
  INVALID_FULFILMENT_STATUS_MESSAGE,
  NEXT_STAGE_MESSAGE,
  noOptionsMessage,
  STATUS_MODE_MESSAGE,
} from './online-order-messages';

/**
 * A paid web order not yet delivered, collected or cancelled (C7-3): the
 * Online Orders screen's Active tab (C7-4), and account deletion's refusal
 * (Q36), so "active" means one thing.
 */
export const ACTIVE_ONLINE_STATUSES: OnlineFulfilmentStatus[] = [
  OnlineFulfilmentStatus.RECEIVED,
  OnlineFulfilmentStatus.PREPARING,
  OnlineFulfilmentStatus.ON_THE_WAY,
  OnlineFulfilmentStatus.READY,
];

/**
 * The staff app's words for each stored stage (D31; the demo's
 * `online.status` list: "Paid", "Preparing", "Out for Delivery", "Ready for
 * Pickup", "Completed", "Cancelled"), for the Cashier's bell item (C7-7).
 * Delivered and Collected are both the demo's one "Completed".
 */
export const STAFF_ONLINE_STATUS_LABELS: Readonly<
  Record<OnlineFulfilmentStatus, string>
> = {
  [OnlineFulfilmentStatus.RECEIVED]: 'Paid',
  [OnlineFulfilmentStatus.PREPARING]: 'Preparing',
  [OnlineFulfilmentStatus.ON_THE_WAY]: 'Out for Delivery',
  [OnlineFulfilmentStatus.READY]: 'Ready for Pickup',
  [OnlineFulfilmentStatus.DELIVERED]: 'Completed',
  [OnlineFulfilmentStatus.COLLECTED]: 'Completed',
  [OnlineFulfilmentStatus.CANCELLED]: 'Cancelled',
};

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
export function webDocketItems(
  lines: readonly (DocketItem & Pick<PricedLine, 'department'>)[],
): DocketItem[] {
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
  lines: readonly BarLine[],
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

// ---------------------------------------------------------------------------
// The staff commands (plan §5.4, card C7-4): the demo's `online.*` rules,
// as pure functions, so a unit test pins each sentence and its order.
// ---------------------------------------------------------------------------

/**
 * The stored word for the demo's one "Completed": Delivered for a
 * delivery, Collected for a pickup (D31: the customer's labels need both).
 */
export function completedStatus(mode: OnlineOrderMode): OnlineFulfilmentStatus {
  return mode === OnlineOrderMode.PICKUP
    ? OnlineFulfilmentStatus.COLLECTED
    : OnlineFulfilmentStatus.DELIVERED;
}

/**
 * The demo's `allowed` path for an order's mode: Paid, Preparing, then
 * Ready for Pickup or Out for Delivery, then Completed.
 */
export function fulfilmentPath(
  mode: OnlineOrderMode,
): OnlineFulfilmentStatus[] {
  return [
    OnlineFulfilmentStatus.RECEIVED,
    OnlineFulfilmentStatus.PREPARING,
    mode === OnlineOrderMode.PICKUP
      ? OnlineFulfilmentStatus.READY
      : OnlineFulfilmentStatus.ON_THE_WAY,
    completedStatus(mode),
  ];
}

/** Delivered or Collected: the demo's Completed. */
export function isCompleted(status: OnlineFulfilmentStatus): boolean {
  return (
    status === OnlineFulfilmentStatus.DELIVERED ||
    status === OnlineFulfilmentStatus.COLLECTED
  );
}

/** Completed or Cancelled: the demo's closed order, its History tab. */
export function isClosed(status: OnlineFulfilmentStatus): boolean {
  return isCompleted(status) || status === OnlineFulfilmentStatus.CANCELLED;
}

/**
 * The demo's `online.status` stage rule: the order's current stage again,
 * or the next one on its own path; anything else (an earlier stage, a
 * skip, the other mode's stage, a word that is no stage) is the manager's
 * correction. Null when the move is allowed. The order must not be closed
 * (the caller refuses that first, with its own sentence).
 */
export function nextStageProblem(
  mode: OnlineOrderMode,
  current: OnlineFulfilmentStatus,
  next: unknown,
): string | null {
  const path: unknown[] = fulfilmentPath(mode);
  const from = path.indexOf(current);
  const to = path.indexOf(next);

  return to >= from && to <= from + 1 && to !== -1 ? null : NEXT_STAGE_MESSAGE;
}

/** The stages a manager may correct an order to (never Cancelled). */
const CORRECTABLE: readonly unknown[] = [
  OnlineFulfilmentStatus.RECEIVED,
  OnlineFulfilmentStatus.PREPARING,
  OnlineFulfilmentStatus.READY,
  OnlineFulfilmentStatus.ON_THE_WAY,
  OnlineFulfilmentStatus.DELIVERED,
  OnlineFulfilmentStatus.COLLECTED,
];

/**
 * The demo's `online.correctStatus` checks, in its order: a fulfilment
 * stage at all, then one that belongs to the order's mode. Null when the
 * correction is allowed.
 */
export function correctStatusProblem(
  mode: OnlineOrderMode,
  status: unknown,
): string | null {
  if (!CORRECTABLE.includes(status)) return INVALID_FULFILMENT_STATUS_MESSAGE;

  return (fulfilmentPath(mode) as unknown[]).includes(status)
    ? null
    : STATUS_MODE_MESSAGE;
}

/**
 * What a paid web order is worth now, the demo's `target`: nothing once
 * cancelled, else the bill's total plus the delivery fee (Q21: the fee is
 * its own line, outside the bill).
 */
export function onlineTargetKobo(order: {
  cancelled: boolean;
  billTotalKobo: number;
  feeKobo: number;
}): number {
  return order.cancelled ? 0 : order.billTotalKobo + order.feeKobo;
}

/** The fees an online order snapshotted from its checkout (Q27). */
export interface ZoneFees {
  deliveryJosKobo: number;
  deliveryOutsideKobo: number;
}

/**
 * The delivery fee of a mode, from the fees the order snapshotted (Q27's
 * default: "recompute from the fees snapshotted on the order"): pickup is
 * free.
 */
export function zoneFeeKobo(mode: OnlineOrderMode, fees: ZoneFees): number {
  switch (mode) {
    case OnlineOrderMode.PICKUP:
      return 0;
    case OnlineOrderMode.WITHIN_JOS:
      return fees.deliveryJosKobo;
    case OnlineOrderMode.OUTSIDE_JOS:
      return fees.deliveryOutsideKobo;
  }
}

/** The address zone a delivery mode means (`JOS`, `PLATEAU`); none for pickup. */
export function modeZone(mode: OnlineOrderMode): AddressZone | null {
  switch (mode) {
    case OnlineOrderMode.PICKUP:
      return null;
    case OnlineOrderMode.WITHIN_JOS:
      return AddressZone.JOS;
    case OnlineOrderMode.OUTSIDE_JOS:
      return AddressZone.PLATEAU;
  }
}

/** Whether a mode delivers (the docket's fulfilment). */
export function modeFulfilment(mode: OnlineOrderMode): Fulfilment {
  return mode === OnlineOrderMode.PICKUP
    ? Fulfilment.PICKUP
    : Fulfilment.DELIVERY;
}

/** The menu fields an edited line is judged by. */
export interface EditLineItem {
  name: string;
  active: boolean;
  choiceLabel: string | null;
  choiceOptions: readonly string[];
}

/**
 * The demo's `online.edit` line checks, in its order: the dish is on the
 * menu (Restaurant or Bar, D30; a dish taken off sale only if the order
 * already has it, so a manager can still keep or cut it), then its
 * choice: one of its options when it has a choice, none when it has not.
 * Null when the line is allowed.
 */
export function editLineProblem(
  item: EditLineItem | null,
  option: string,
  alreadyOnOrder: boolean,
): string | null {
  if (item === null || (!item.active && !alreadyOnOrder)) {
    return EDIT_MENU_ITEM_MESSAGE;
  }

  if (item.choiceOptions.length > 0) {
    return item.choiceOptions.includes(option)
      ? null
      : chooseOptionMessage(item.choiceLabel ?? 'an option', item.name);
  }

  return option === '' ? null : noOptionsMessage(item.name);
}

/** One line of a web order, as the Bar's moves read it. */
export interface BarLine {
  menuItemId: string;
  name: string;
  qty: number;
  department: Department;
}

/** One Bar movement an edit or a cancellation makes. */
export interface BarDifference {
  stockItemId: string;
  /** Servings: negative when more leave the Bar, positive when some return. */
  delta: number;
}

/**
 * The Bar movements that take a web order's drinks from `before` to
 * `after` (D30: "online.edit … moves stock by the difference; cancel
 * returns it"): one per paired stock item whose servings changed, in
 * stock-item id order (as `webSalePlan`, so two commands sharing drinks
 * cannot deadlock), and the drinks with no paired item, which move
 * nothing.
 */
export function barDifference(
  before: readonly BarLine[],
  after: readonly BarLine[],
  pairedStockItemByMenuItem: ReadonlyMap<string, string>,
): { moves: BarDifference[]; unpaired: string[] } {
  const was = webSalePlan(before, pairedStockItemByMenuItem);
  const now = webSalePlan(after, pairedStockItemByMenuItem);
  const delta = new Map<string, number>();

  for (const move of was.moves) {
    delta.set(move.stockItemId, (delta.get(move.stockItemId) ?? 0) + move.qty);
  }

  for (const move of now.moves) {
    delta.set(move.stockItemId, (delta.get(move.stockItemId) ?? 0) - move.qty);
  }

  const moves = [...delta.entries()]
    .filter(([, qty]) => qty !== 0)
    .map(([stockItemId, qty]) => ({ stockItemId, delta: qty }))
    .sort((a, b) =>
      a.stockItemId < b.stockItemId
        ? -1
        : a.stockItemId > b.stockItemId
          ? 1
          : 0,
    );

  return {
    moves,
    unpaired: [...new Set([...was.unpaired, ...now.unpaired])],
  };
}
