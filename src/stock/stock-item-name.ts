import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../../generated/cnc-client';
import { uniqueViolationTargets } from '../prisma/unique-violation';
import { STOCK_ITEM_EXISTS_MESSAGE } from './stock-messages';

/**
 * A stock item's name is unique ignoring case (the migration's
 * `StockItem_name_key` on `lower(name)`), and two commands create stock
 * items: `stockitem.create` and `menu.save` for a new Bar item's pair. Both
 * refuse a clash the same way, from here.
 */

/**
 * 409 "This stock item already exists." when a stock item already holds the
 * name, ignoring case, as the unique index does. Checked by query for the
 * sentence; the index still decides a race ({@link rethrowStockNameClash}).
 */
export async function assertStockNameFree(
  tx: Pick<Prisma.TransactionClient, 'stockItem'>,
  name: string,
): Promise<void> {
  const holder = await tx.stockItem.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });

  if (holder !== null) {
    throw new ConflictException(STOCK_ITEM_EXISTS_MESSAGE);
  }
}

/** A stock-name clash that raced past the query: the same 409. */
export function rethrowStockNameClash(error: unknown): never {
  const targets = uniqueViolationTargets(error);

  if (targets.length === 1 && targets[0] === 'name') {
    throw new ConflictException(STOCK_ITEM_EXISTS_MESSAGE);
  }

  throw error;
}
