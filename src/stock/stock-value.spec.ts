import { StockKind } from '../../generated/cnc-client';
import { stockValueKobo } from './stock-value';

/** A reader that knows one menu price. */
function readerWithPrice(priceKobo: number | null) {
  const findUnique = jest.fn(() =>
    Promise.resolve(priceKobo === null ? null : { priceKobo }),
  );

  return {
    reader: { menuItem: { findUnique } } as unknown as Parameters<
      typeof stockValueKobo
    >[0],
    findUnique,
  };
}

describe('stockValueKobo (the demo wasteValue)', () => {
  it('values a Bar item at its menu price times the quantity, by size', async () => {
    const { reader } = readerWithPrice(350000);
    const bar = {
      id: 's1',
      kind: StockKind.BAR,
      factor: 12,
      menuItemId: 'm1',
    };

    await expect(stockValueKobo(reader, bar, 2)).resolves.toBe(700000);
    await expect(stockValueKobo(reader, bar, -3)).resolves.toBe(1050000);
  });

  it('values nothing at zero without reading', async () => {
    const { reader, findUnique } = readerWithPrice(350000);

    await expect(
      stockValueKobo(
        reader,
        { id: 's1', kind: StockKind.BAR, factor: 12, menuItemId: 'm1' },
        0,
      ),
    ).resolves.toBe(0);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('values a Kitchen item at zero while no purchase cost is known (C5 adds it)', async () => {
    const { reader, findUnique } = readerWithPrice(null);

    await expect(
      stockValueKobo(
        reader,
        { id: 's2', kind: StockKind.KITCHEN, factor: 50, menuItemId: null },
        7,
      ),
    ).resolves.toBe(0);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
