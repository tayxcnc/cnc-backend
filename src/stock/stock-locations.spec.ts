import { StockKind, StockLocation } from '../../generated/cnc-client';
import { isLow, locationHolds, locationsFor } from './stock-locations';

describe('stock locations', () => {
  it.each([
    [StockKind.KITCHEN, StockLocation.STORE, true],
    [StockKind.KITCHEN, StockLocation.KITCHEN, true],
    [StockKind.KITCHEN, StockLocation.BAR, false],
    [StockKind.BAR, StockLocation.STORE, true],
    [StockKind.BAR, StockLocation.BAR, true],
    [StockKind.BAR, StockLocation.KITCHEN, false],
  ])('a %s item at the %s: %p', (kind, location, holds) => {
    expect(locationHolds(kind, location)).toBe(holds);
  });

  it('lists the Store first, then the item’s own location', () => {
    expect(locationsFor(StockKind.KITCHEN)).toEqual([
      StockLocation.STORE,
      StockLocation.KITCHEN,
    ]);
    expect(locationsFor(StockKind.BAR)).toEqual([
      StockLocation.STORE,
      StockLocation.BAR,
    ]);
  });

  it('calls the Store low only when it is out, and elsewhere below the reorder level', () => {
    expect(isLow(StockLocation.STORE, 1, 15)).toBe(false);
    expect(isLow(StockLocation.STORE, 0, 15)).toBe(true);
    expect(isLow(StockLocation.KITCHEN, 14, 15)).toBe(true);
    expect(isLow(StockLocation.KITCHEN, 15, 15)).toBe(false);
    expect(isLow(StockLocation.BAR, -2, 0)).toBe(true);
  });
});
