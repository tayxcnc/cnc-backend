import {
  PurchaseStatus,
  StockKind,
  StockLocation,
} from '../../generated/cnc-client';
import {
  latestPackCostKobo,
  stockValueAtKobo,
  stockValueKobo,
} from './stock-value';

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

describe('stockValueAtKobo (Q25: as the location holds it)', () => {
  const bar = { id: 's1', kind: StockKind.BAR, factor: 12, menuItemId: 'm1' };

  it('values the Kitchen and the Bar in units, as stockValueKobo does', async () => {
    const { reader: tx } = reader(350000, 7000000);

    await expect(
      stockValueAtKobo(tx, kitchenItem, StockLocation.KITCHEN, 2),
    ).resolves.toBe(280000);
    await expect(
      stockValueAtKobo(tx, bar, StockLocation.BAR, -3),
    ).resolves.toBe(1050000);
  });

  it('values Store stock per pack: one bag of rice at ₦70,000 is ₦70,000, not ₦1,400', async () => {
    const { reader: tx } = reader(null, 7000000);

    await expect(
      stockValueAtKobo(tx, kitchenItem, StockLocation.STORE, 1),
    ).resolves.toBe(7000000);
    await expect(
      stockValueAtKobo(tx, kitchenItem, StockLocation.STORE, -3),
    ).resolves.toBe(21000000);
    // Exactly packs × cost, with no division to round.
    await expect(
      stockValueAtKobo(
        tx,
        { ...kitchenItem, factor: 3 },
        StockLocation.STORE,
        1,
      ),
    ).resolves.toBe(7000000);
  });

  it('values a Store pack of a Bar item at How Many in One servings at the menu price', async () => {
    const { reader: tx, findFirst } = reader(500000, 999999);

    // The C4 review's nine batches of a ₦5,000 drink, twelve to a batch.
    await expect(
      stockValueAtKobo(tx, bar, StockLocation.STORE, 9),
    ).resolves.toBe(54000000);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('values a Store item with no known cost, and nothing, at zero', async () => {
    const { reader: tx, findUnique, findFirst } = reader(null, null);

    await expect(
      stockValueAtKobo(tx, kitchenItem, StockLocation.STORE, 4),
    ).resolves.toBe(0);
    findFirst.mockClear();
    await expect(
      stockValueAtKobo(tx, kitchenItem, StockLocation.STORE, 0),
    ).resolves.toBe(0);
    expect(findUnique).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe('latestPackCostKobo', () => {
  it('reads the newest line for the item on an Approved or Fulfilled purchase only (Q25)', async () => {
    const { reader: tx, findFirst } = reader(null, 450000);

    await expect(latestPackCostKobo(tx, 's9')).resolves.toBe(450000);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        stockItemId: 's9',
        purchase: {
          status: {
            in: [PurchaseStatus.APPROVED, PurchaseStatus.FULFILLED],
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
