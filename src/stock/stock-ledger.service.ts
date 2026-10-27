import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  StaffRole,
  type StockLocation,
  type StockMovementType,
} from '../../generated/cnc-client';
import { asId, asStockItemName, watDay } from '../push/push-input-types';
import { PushQueueService } from '../push/push-queue.service';
import { isLow, locationHolds } from './stock-locations';
import {
  insufficientStockMessage,
  STOCK_ITEM_NOT_FOUND_MESSAGE,
} from './stock-messages';

type Tx = Prisma.TransactionClient;

/** One change to one balance, and why. */
export interface StockMove {
  stockItemId: string;
  location: StockLocation;
  /**
   * A whole number: packs at the Store, units elsewhere. Negative is stock
   * leaving. Zero moves nothing and writes nothing, as in the demo's
   * `move`.
   */
  qty: number;
  type: StockMovementType;
  /** What the screens show beside the movement: an order number, a note. */
  ref: string;
  /** Who moved it; null only for a movement nobody on the staff made. */
  staffId: string | null;
  /**
   * True only for a paid web order's drinks (plan §7.4): the money is
   * already taken, so the Bar balance may go below zero and the shortfall
   * shows in Low Stock. Every other decrement is refused below zero.
   */
  allowNegative?: boolean;
}

/**
 * The one writer of `StockBalance` and `StockMovement` (plan §4.6): the
 * demo's `move`, on the server, with TAY's `StockService` rules.
 *
 * - **Never a balance without its movement.** Both are written here, in the
 *   caller's transaction, so the balance is always the running sum of the
 *   movements, and every movement explains a change that happened.
 * - **A decrement is conditional**: one `UPDATE … WHERE qty + delta >= 0`,
 *   no read first, so two commands taking the last portion cannot both
 *   succeed. A refusal is 409 with the demo's sentence ("Insufficient
 *   kitchen stock for Rice."), thrown inside the caller's transaction so the
 *   whole command rolls back.
 * - **An item moves only where it is held** (`locationHolds`): commands
 *   check that first with their own sentence; reaching here otherwise is a
 *   programming error.
 *
 * Later cards move stock only through this service: a Bar settlement and
 * its reversal (C4-5), kitchen entries (C4-6), requests, purchases and
 * waste (C5), and paid web orders (C7).
 *
 * **Low stock pushes (C10, PS8).** A movement that takes a balance from
 * not low to low (`isLow`, the bell's rule) queues the Store's push, once
 * per item, location and Lagos day. Queued only: the push sweep sends it
 * (D14), so no command, the till's included, waits on a push service. The
 * threshold comes with the item read `move` already makes, and the push's
 * savepoint is entered only on a crossing.
 */
@Injectable()
export class StockLedgerService {
  constructor(private readonly push: PushQueueService) {}

  /**
   * Apply one movement, or refuse and change nothing. Returns the balance
   * after it, or null when `qty` is zero and nothing moved.
   */
  async move(tx: Tx, move: StockMove): Promise<number | null> {
    if (!Number.isSafeInteger(move.qty)) {
      throw new Error(`A stock movement must be whole; got ${move.qty}.`);
    }

    if (move.qty === 0) return null;

    const item = await tx.stockItem.findUnique({
      where: { id: move.stockItemId },
      select: { name: true, kind: true, minimum: true },
    });

    if (item === null) {
      throw new NotFoundException(STOCK_ITEM_NOT_FOUND_MESSAGE);
    }

    if (!locationHolds(item.kind, move.location)) {
      throw new Error(
        `A ${item.kind} stock item cannot move at the ${move.location}.`,
      );
    }

    await this.ensureBalances(tx, [move.stockItemId], move.location);

    const guarded = move.qty < 0 && move.allowNegative !== true;
    const rows = await tx.$queryRaw<{ qty: number }[]>`
      UPDATE "StockBalance"
         SET "qty" = "qty" + ${move.qty},
             "updatedAt" = (now() AT TIME ZONE 'UTC')
       WHERE "stockItemId" = ${move.stockItemId}
         AND "location" = ${move.location}::"StockLocation"
         ${guarded ? Prisma.sql`AND "qty" + ${move.qty} >= 0` : Prisma.empty}
   RETURNING "qty"`;

    if (rows.length === 0) {
      throw new ConflictException(
        insufficientStockMessage(move.location, item.name),
      );
    }

    await tx.stockMovement.create({
      data: {
        stockItemId: move.stockItemId,
        location: move.location,
        qty: move.qty,
        type: move.type,
        ref: move.ref,
        staffId: move.staffId,
      },
      select: { id: true },
    });

    const after = Number(rows[0].qty);
    const before = after - move.qty;

    if (
      !isLow(move.location, before, item.minimum) &&
      isLow(move.location, after, item.minimum)
    ) {
      // The topic is not dispatched: the push sweep sends it.
      await this.push.enqueueStaff(
        tx,
        'stock.low',
        () => ({
          stockItemId: asId(move.stockItemId),
          item: asStockItemName(item.name),
          location: move.location,
          day: watDay(new Date()),
        }),
        {
          roles: [StaffRole.STOREKEEPER],
          except: move.staffId === null ? [] : [move.staffId],
        },
      );
    }

    return after;
  }

  /**
   * Lock the balances of several items at one location and return them,
   * for a command that must read a balance and then move it by the
   * difference (a stock count). Missing rows are created at zero first, so
   * every item has a row to lock.
   *
   * The rows are locked in id order, so two counts over overlapping items
   * take their locks in the same order and cannot deadlock each other. The
   * locks are held until the caller's transaction ends, so no movement can
   * land between the read and the caller's own move.
   */
  async lockBalances(
    tx: Tx,
    stockItemIds: readonly string[],
    location: StockLocation,
  ): Promise<Map<string, number>> {
    const ids = [...new Set(stockItemIds)].sort();

    if (ids.length === 0) return new Map();

    await this.ensureBalances(tx, ids, location);

    const rows = await tx.$queryRaw<{ stockItemId: string; qty: number }[]>`
      SELECT "stockItemId", "qty"
        FROM "StockBalance"
       WHERE "stockItemId" IN (${Prisma.join(ids)})
         AND "location" = ${location}::"StockLocation"
       ORDER BY "stockItemId"
         FOR UPDATE`;

    return new Map(rows.map((row) => [row.stockItemId, Number(row.qty)]));
  }

  /**
   * A zero balance row for each item that has none at this location. An
   * insert that skips duplicates (`ON CONFLICT DO NOTHING`), so two first
   * movements of one item cannot both insert: the second waits for the
   * first and then finds its row.
   */
  private async ensureBalances(
    tx: Tx,
    stockItemIds: readonly string[],
    location: StockLocation,
  ): Promise<void> {
    await tx.stockBalance.createMany({
      data: stockItemIds.map((stockItemId) => ({
        stockItemId,
        location,
        qty: 0,
      })),
      skipDuplicates: true,
    });
  }
}
