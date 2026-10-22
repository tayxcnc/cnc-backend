import {
  type Prisma,
  StockKind,
  StockLocation,
} from '../../generated/cnc-client';
import { APPROVED_PURCHASE_STATUSES } from '../purchasing/purchase-rules';

/** The item fields a valuation needs. */
export interface ValuedStockItem {
  id: string;
  kind: StockKind;
  factor: number;
  menuItemId: string | null;
}

type Reader = Pick<Prisma.TransactionClient, 'menuItem' | 'purchaseLine'>;

/**
 * A Bar item's menu price, the price its stock is valued at, or undefined
 * for an item that is not valued by price (a Kitchen item, or a Bar item
 * with no dish). A Bar item whose dish has gone values at zero, as in the
 * demo.
 */
async function barPriceKobo(
  tx: Reader,
  item: ValuedStockItem,
): Promise<number | undefined> {
  if (item.kind !== StockKind.BAR || item.menuItemId === null) {
    return undefined;
  }

  const menuItem = await tx.menuItem.findUnique({
    where: { id: item.menuItemId },
    select: { priceKobo: true },
  });

  return menuItem?.priceKobo ?? 0;
}

/**
 * What a quantity of stock is worth, in kobo: the demo's `wasteValue`
 * (`staff/lib/domain.ts`) for a quantity **in units** (servings, portions).
 *
 * - **A Bar item** is valued at its menu price × the quantity.
 * - **A Kitchen item** is valued at the latest pack cost ÷ the pack's units
 *   × the quantity, rounded to the kobo; with no pack cost known it counts
 *   as zero, as in the demo.
 *
 * The quantity's size is valued; a caller passes a signed difference and
 * gets a positive value. Stock held at a location is valued through
 * {@link stockValueAtKobo}, which knows the Store holds packs.
 */
export async function stockValueKobo(
  tx: Reader,
  item: ValuedStockItem,
  qty: number,
): Promise<number> {
  const size = Math.abs(qty);

  if (size === 0) return 0;

  const price = await barPriceKobo(tx, item);

  if (price !== undefined) return price * size;

  const packCostKobo = await latestPackCostKobo(tx, item.id);

  return packCostKobo === null
    ? 0
    : Math.round((packCostKobo / item.factor) * size);
}

/**
 * What a quantity of stock **as `location` holds it** is worth, in kobo:
 * the one valuation a stock count (Q28) and a write-off (Q25) share, so the
 * same goods counted short or written off are worth the same.
 *
 * The Kitchen and the Bar hold units, valued by {@link stockValueKobo}.
 * The Store holds packs, valued per pack (Q25, answered 2026-10-22): a
 * Kitchen item at packs × the latest pack cost, exactly, and a Bar item at
 * packs × How Many in One × its menu price. One bag of rice at ₦70,000 a
 * bag is ₦70,000, not the ₦1,400 of one portion, so a Store write-off is
 * held to the Owner Approval Limit at what was lost (and the C4 review's
 * Store count of nine batches of a ₦5,000 drink is ₦540,000).
 */
export async function stockValueAtKobo(
  tx: Reader,
  item: ValuedStockItem,
  location: StockLocation,
  qty: number,
): Promise<number> {
  if (location !== StockLocation.STORE) {
    return stockValueKobo(tx, item, qty);
  }

  const packs = Math.abs(qty);

  if (packs === 0) return 0;

  const price = await barPriceKobo(tx, item);

  if (price !== undefined) return price * item.factor * packs;

  const packCostKobo = await latestPackCostKobo(tx, item.id);

  return packCostKobo === null ? 0 : packCostKobo * packs;
}

/**
 * The latest cost of one pack of an item: the line for the item on the
 * most recently raised purchase that is Approved or Fulfilled
 * (`APPROVED_PURCHASE_STATUSES`; Q25, answered 2026-10-22). Null when no
 * such line exists, which values the stock at zero, as in the demo.
 *
 * A Pending requisition is no cost anyone has agreed: whoever raised it
 * would otherwise set the value their own write-offs and counts are held
 * to the limits on, before any manager reviewed it (the C5 review).
 * Rejected and Cancelled ones never were a cost, as in the demo. Receiving
 * is all at once (D39), so a received purchase is Fulfilled, archived or
 * not; an Approved one archived before receiving is Cancelled.
 *
 * "Latest" stays the most recently raised costing purchase, not the most
 * recently received line: the decision names which purchases count, and
 * the raised order is the one the demo and the C5 tests use.
 *
 * A purchase holds one line per item (unique), so "the last line" is the
 * line on the most recently raised costing purchase; an edit replaces a
 * purchase's lines but not its place. One query: the relation filter and
 * order are a join, not a nested read, so it is safe inside a transaction.
 */
export async function latestPackCostKobo(
  tx: Pick<Prisma.TransactionClient, 'purchaseLine'>,
  stockItemId: string,
): Promise<number | null> {
  const line = await tx.purchaseLine.findFirst({
    where: {
      stockItemId,
      purchase: { status: { in: [...APPROVED_PURCHASE_STATUSES] } },
    },
    orderBy: [
      { purchase: { createdAt: 'desc' } },
      { purchase: { id: 'desc' } },
    ],
    select: { costKobo: true },
  });

  return line === null ? null : line.costKobo;
}
