import { PurchaseStatus } from '../../generated/cnc-client';
import { INT4_MAX } from '../prisma/int4';

/**
 * The purchasing rules (plan §4.6, §7.7, §17 R1), pure, from the demo's
 * `purchase.*` commands and `purchaseTotal` (`staff/lib/domain.ts`), so
 * each is unit-tested without a database.
 */

/** The statuses `purchase.status` may set; Fulfilled is set only by receiving. */
export const SETTABLE_PURCHASE_STATUSES = [
  PurchaseStatus.PENDING,
  PurchaseStatus.APPROVED,
  PurchaseStatus.REJECTED,
  PurchaseStatus.CANCELLED,
] as const;

export type SettablePurchaseStatus =
  (typeof SETTABLE_PURCHASE_STATUSES)[number];

/** The statuses that end a purchase's work: the screen's History view. */
export const CLOSED_PURCHASE_STATUSES: readonly PurchaseStatus[] = [
  PurchaseStatus.FULFILLED,
  PurchaseStatus.REJECTED,
  PurchaseStatus.CANCELLED,
];

/**
 * The statuses of a purchase a manager or the Owner has approved: Approved,
 * and Fulfilled (approved, then received; receiving is all at once, D39,
 * so there is no partly received status). Two rules read it, so they
 * cannot disagree on what "approved" means (the founder's decisions of
 * 2026-10-22): only these purchases set the pack cost stock is valued at
 * (Q25, `latestPackCostKobo`), and a correction of one counts its increase
 * toward the day and refuses the manager who raised it (`purchase.edit`).
 */
export const APPROVED_PURCHASE_STATUSES: readonly PurchaseStatus[] = [
  PurchaseStatus.APPROVED,
  PurchaseStatus.FULFILLED,
];

/** Whether a purchase in `status` was approved ({@link APPROVED_PURCHASE_STATUSES}). */
export function isApprovedPurchase(status: PurchaseStatus): boolean {
  return APPROVED_PURCHASE_STATUSES.includes(status);
}

/** The demo's `purchaseTotal`: packs × cost per pack over every line, in kobo. */
export function purchaseTotalKobo(
  lines: readonly { qtyPacks: number; costKobo: number }[],
): number {
  return lines.reduce(
    (total, line) => total + line.qtyPacks * line.costKobo,
    0,
  );
}

/** What reached the Store: received packs × cost per pack, in kobo. */
export function receivedValueKobo(
  lines: readonly { receivedPacks: number; costKobo: number }[],
): number {
  return lines.reduce(
    (total, line) => total + line.receivedPacks * line.costKobo,
    0,
  );
}

/** Whether any goods on the purchase reached the Store. */
export function hasReceived(
  lines: readonly { receivedPacks: number }[],
): boolean {
  return lines.some((line) => line.receivedPacks > 0);
}

/** Whether a purchase belongs in the History view rather than the active list. */
export function isClosedPurchase(purchase: {
  archived: boolean;
  status: PurchaseStatus;
}): boolean {
  return (
    purchase.archived || CLOSED_PURCHASE_STATUSES.includes(purchase.status)
  );
}

/**
 * The demo's cost check on a line: a whole number of kobo above zero. A
 * figure above the `Int` column's range would reach Postgres as a 500, so
 * it fails the same check.
 */
export function isLineCost(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= INT4_MAX
  );
}

/**
 * The Store movements a correction of a received purchase makes (the
 * demo's `purchase.edit`): for every item on the old lines or the new, the
 * new quantity less what was received. A received purchase's lines are
 * received in full again after the edit, so the Store then holds exactly
 * the corrected packs. Items in the order they first appear; zero moves
 * are left out.
 */
export function correctionMoves(
  oldLines: readonly { stockItemId: string; receivedPacks: number }[],
  newLines: readonly { stockItemId: string; qtyPacks: number }[],
): { stockItemId: string; qty: number }[] {
  const items = [
    ...new Set([
      ...oldLines.map((line) => line.stockItemId),
      ...newLines.map((line) => line.stockItemId),
    ]),
  ];

  return items
    .map((stockItemId) => {
      const received =
        oldLines.find((line) => line.stockItemId === stockItemId)
          ?.receivedPacks ?? 0;
      const next =
        newLines.find((line) => line.stockItemId === stockItemId)?.qtyPacks ??
        0;

      return { stockItemId, qty: next - received };
    })
    .filter((move) => move.qty !== 0);
}

/** The automatic task a purchase in a status waits on, if any. */
export type PurchaseTaskKind = 'REVIEW' | 'RECEIVE';

/**
 * Which automatic task belongs to a status (plan §7.7, §17 R1): a Pending
 * purchase waits on a manager's review, an Approved one on the
 * Storekeeper's receiving, and any other status on nobody. The demo raised
 * the receive task only from `purchase.approve`; R1 raises it whenever a
 * purchase becomes Approved, and the same rule gives a purchase returned to
 * Pending its review again.
 */
export function taskForStatus(status: PurchaseStatus): PurchaseTaskKind | null {
  if (status === PurchaseStatus.PENDING) return 'REVIEW';
  if (status === PurchaseStatus.APPROVED) return 'RECEIVE';

  return null;
}

/** The demo's review task title: "Review purchase PR-000091 from Plateau Fresh Foods". */
export function reviewTaskTitle(number: string, vendorName: string): string {
  return `Review purchase ${number} from ${vendorName}`;
}

/** The demo's receive task title: "Receive goods for PR-000091". */
export function receiveTaskTitle(number: string): string {
  return `Receive goods for ${number}`;
}
