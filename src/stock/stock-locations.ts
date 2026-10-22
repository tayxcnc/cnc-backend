import {
  StaffRole,
  StockKind,
  StockLocation,
  StockMovementType,
} from '../../generated/cnc-client';

/**
 * The Store-side movement type for an issue to each location (the demo's
 * "Issue to Kitchen", "Issue to Bar"). One map for the direct issue
 * (`stock.issue`) and a request's issue (`request.issue`), so the same
 * transfer is recorded under the same type whichever route made it.
 */
export const ISSUE_TYPE = {
  [StockLocation.KITCHEN]: StockMovementType.ISSUE_TO_KITCHEN,
  [StockLocation.BAR]: StockMovementType.ISSUE_TO_BAR,
} as const;

/**
 * The one location a role reads on Stock & Requests (plan §5.4, §6.1): a
 * Bartender the Bar, a Kitchen user the Kitchen. Undefined for the
 * Storekeeper and managers, who read every location. Shared by the
 * balances read and the requests read, so the two cannot scope a role
 * differently.
 */
export function scopedStockLocation(
  role: StaffRole,
): StockLocation | undefined {
  if (role === StaffRole.BARTENDER) return StockLocation.BAR;
  if (role === StaffRole.KITCHEN) return StockLocation.KITCHEN;

  return undefined;
}

/**
 * Which locations hold which items (plan §4.6, §7.6): every item is bought
 * into the Store; a Kitchen item is used in the Kitchen and a Bar item at
 * the Bar. The demo's `fits` (`bar-` ids at the Bar, the rest in the
 * Kitchen), keyed on `StockItem.kind` instead of an id prefix (D45).
 *
 * One definition, used by every command that names a location and by the
 * ledger, so no movement can put a portion behind the bar.
 */
export function locationHolds(
  kind: StockKind,
  location: StockLocation,
): boolean {
  if (location === StockLocation.STORE) return true;

  return (location === StockLocation.BAR) === (kind === StockKind.BAR);
}

/** The locations an item of this kind is held at, Store first. */
export function locationsFor(kind: StockKind): StockLocation[] {
  return [
    StockLocation.STORE,
    kind === StockKind.BAR ? StockLocation.BAR : StockLocation.KITCHEN,
  ];
}

/**
 * The demo's `isLow`: the Store is low only when it is out (it counts
 * packs, so one pack left is stock); the Kitchen and the Bar are low below
 * the item's reorder level.
 */
export function isLow(
  location: StockLocation,
  qty: number,
  minimum: number,
): boolean {
  return qty < (location === StockLocation.STORE ? 1 : minimum);
}
