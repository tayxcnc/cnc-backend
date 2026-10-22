import {
  type Prisma,
  PurchaseStatus,
  StockKind,
} from '../../generated/cnc-client';

/** The item fields a valuation needs. */
export interface ValuedStockItem {
  id: string;
  kind: StockKind;
  factor: number;
  menuItemId: string | null;
}

type Reader = Pick<Prisma.TransactionClient, 'menuItem' | 'purchaseLine'>;

/**
 * The purchases whose lines do not set a pack cost: the demo's `wasteValue`
 * skips Rejected and Cancelled requisitions, whatever else they say.
 */
const COSTLESS_PURCHASES: readonly PurchaseStatus[] = [
  PurchaseStatus.REJECTED,
  PurchaseStatus.CANCELLED,
];

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
 * gets a positive value. **The quantity is in units** (servings, portions):
 * the Store holds packs, so a caller valuing Store stock multiplies by the
 * item's `factor` first (C4 review: a Store count of Bar batches was
 * otherwise valued as single servings).
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

  const packCostKobo = await latestPackCostKobo(tx, item.id);

  return packCostKobo === null
    ? 0
    : Math.round((packCostKobo / item.factor) * size);
}

/**
 * The latest purchase cost of one pack of an item: in the demo, the last
 * line for the item on any purchase that was not rejected or cancelled,
 * the purchases taken in the order they were raised (C5-1). Null when no
 * such line exists, which values the stock at zero, as in the demo.
 *
 * A purchase holds one line per item (unique), so "the last line" is the
 * line on the most recently raised purchase; an edit replaces a purchase's
 * lines but not its place. One query: the relation filter and order are a
 * join, not a nested read, so it is safe inside a transaction.
 *
 * Q25 asks whether "latest" should instead mean the most recently received
 * line; until it is answered, this is the coded rule.
 */
export async function latestPackCostKobo(
  tx: Pick<Prisma.TransactionClient, 'purchaseLine'>,
  stockItemId: string,
): Promise<number | null> {
  const line = await tx.purchaseLine.findFirst({
    where: {
      stockItemId,
      purchase: { status: { notIn: [...COSTLESS_PURCHASES] } },
    },
    orderBy: [
      { purchase: { createdAt: 'desc' } },
      { purchase: { id: 'desc' } },
    ],
    select: { costKobo: true },
  });

  return line === null ? null : line.costKobo;
}
