import { type Prisma, StockKind } from '../../generated/cnc-client';

/** The item fields a valuation needs. */
export interface ValuedStockItem {
  id: string;
  kind: StockKind;
  factor: number;
  menuItemId: string | null;
}

type Reader = Pick<Prisma.TransactionClient, 'menuItem'>;

/**
 * What a quantity of stock is worth, in kobo: the demo's `wasteValue`
 * (`staff/lib/domain.ts`), the coded formula plan §4.6 and §7.8 keep until
 * Q25 is answered. Q28's default values a stock count's difference "as
 * waste is valued", so the count and (from C5) waste share this one
 * function.
 *
 * - **A Bar item** is valued at its menu price × the quantity, whatever the
 *   location (the demo's rule, which Q25 asks about).
 * - **A Kitchen item** is valued at the latest purchase cost per pack ÷ the
 *   pack's units × the quantity, rounded to the kobo; with no purchase cost
 *   known it counts as zero, as in the demo.
 *
 * The quantity's size is valued; a caller passes a signed difference and
 * gets a positive value.
 */
export async function stockValueKobo(
  tx: Reader,
  item: ValuedStockItem,
  qty: number,
): Promise<number> {
  const size = Math.abs(qty);

  if (size === 0) return 0;

  if (item.kind === StockKind.BAR && item.menuItemId !== null) {
    const menuItem = await tx.menuItem.findUnique({
      where: { id: item.menuItemId },
      select: { priceKobo: true },
    });

    return (menuItem?.priceKobo ?? 0) * size;
  }

  const packCostKobo = latestPackCostKobo(item.id);

  return packCostKobo === null
    ? 0
    : Math.round((packCostKobo / item.factor) * size);
}

/**
 * The latest purchase cost of one pack of a Kitchen item: in the demo, the
 * last line for the item on any purchase that was not rejected or
 * cancelled.
 *
 * **Null until purchasing exists (C5).** Purchases and their lines are C5's
 * schema (plan §15, C5-1), so in C4 no Kitchen item has a known cost and,
 * exactly as in the demo with no purchases, its value counts as zero. C5
 * replaces this body with the read; every caller already handles the null.
 */
function latestPackCostKobo(stockItemId: string): number | null {
  void stockItemId;

  return null;
}
