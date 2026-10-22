import { StockKind, StockLocation } from '../../generated/cnc-client';

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
