import { PurchaseStatus, StockKind } from '../../generated/cnc-client';
import { latestPackCostKobo, stockValueKobo } from './stock-value';

/** A reader that knows one menu price and one latest pack cost. */
function reader(priceKobo: number | null, packCostKobo: number | null = null) {
  const findUnique = jest.fn(() =>
    Promise.resolve(priceKobo === null ? null : { priceKobo }),
  );
  const findFirst = jest.fn(() =>
    Promise.resolve(packCostKobo === null ? null : { costKobo: packCostKobo }),
  );

  return {
    reader: {
      menuItem: { findUnique },
      purchaseLine: { findFirst },
    } as unknown as Parameters<typeof stockValueKobo>[0],
    findUnique,
    findFirst,
  };
}

const kitchenItem = {
  id: 's2',
  kind: StockKind.KITCHEN,
  factor: 50,
  menuItemId: null,
};

describe('stockValueKobo (the demo wasteValue)', () => {
  it('values a Bar item at its menu price times the quantity, by size', async () => {
    const { reader: tx, findFirst } = reader(350000, 999999);
    const bar = {
      id: 's1',
      kind: StockKind.BAR,
      factor: 12,
      menuItemId: 'm1',
    };

    await expect(stockValueKobo(tx, bar, 2)).resolves.toBe(700000);
    await expect(stockValueKobo(tx, bar, -3)).resolves.toBe(1050000);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('values nothing at zero without reading', async () => {
    const { reader: tx, findUnique, findFirst } = reader(350000, 100);

    await expect(
      stockValueKobo(
        tx,
        { id: 's1', kind: StockKind.BAR, factor: 12, menuItemId: 'm1' },
        0,
      ),
    ).resolves.toBe(0);
    expect(findUnique).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('values a Kitchen item at zero while no purchase cost is known', async () => {
    const { reader: tx, findUnique } = reader(null, null);

    await expect(stockValueKobo(tx, kitchenItem, 7)).resolves.toBe(0);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('values a Kitchen item at the latest pack cost ÷ the pack’s units × the quantity, rounded to the kobo', async () => {
    // One bag of rice at ₦70,000 holds 50 portions: ₦1,400 a portion.
    const { reader: tx } = reader(null, 7000000);

    await expect(stockValueKobo(tx, kitchenItem, 1)).resolves.toBe(140000);
    await expect(stockValueKobo(tx, kitchenItem, -3)).resolves.toBe(420000);
    await expect(
      stockValueKobo(tx, { ...kitchenItem, factor: 3 }, 1),
    ).resolves.toBe(2333333);
  });
});

describe('latestPackCostKobo', () => {
  it('reads the newest line for the item on a purchase that was not rejected or cancelled', async () => {
    const { reader: tx, findFirst } = reader(null, 450000);

    await expect(latestPackCostKobo(tx, 's9')).resolves.toBe(450000);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        stockItemId: 's9',
        purchase: {
          status: {
            notIn: [PurchaseStatus.REJECTED, PurchaseStatus.CANCELLED],
          },
        },
      },
      orderBy: [
        { purchase: { createdAt: 'desc' } },
        { purchase: { id: 'desc' } },
      ],
      select: { costKobo: true },
    });
  });

  it('is null when no such line exists', async () => {
    const { reader: tx } = reader(null, null);

    await expect(latestPackCostKobo(tx, 's9')).resolves.toBeNull();
  });
});
