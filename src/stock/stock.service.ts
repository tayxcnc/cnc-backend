import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  StaffRole,
  StockKind,
  StockLocation,
  StockMovementType,
} from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { isManager, ROLE_REFUSED_MESSAGE } from '../auth/staff-roles';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import {
  LIMITED_DECISIONS,
  MoneyControlService,
  OWNER_ONLY_ACTIONS,
} from '../money-control/money-control.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { INT4_MAX } from '../prisma/int4';
import { claimVersion } from '../prisma/optimistic-version';
import {
  StockAdjustDirection,
  type CreateStockItemRequest,
  type StockAdjustRequest,
  type StockCountRequest,
  type StockIssueRequest,
  type UpdateStockItemRequest,
} from './dto/stock.request';
import type {
  StockAdjustResponse,
  StockBalancePageResponse,
  StockBalancesQuery,
  StockCountChangeResponse,
  StockCountResponse,
  StockIssueResponse,
  StockItemResponse,
  StockMovementPageResponse,
  StockMovementsQuery,
} from './dto/stock.response';
import { assertStockNameFree, rethrowStockNameClash } from './stock-item-name';
import { StockLedgerService } from './stock-ledger.service';
import { isLow, locationHolds } from './stock-locations';
import {
  COUNT_ROLE_MESSAGE,
  ISSUE_ITEM_MESSAGE,
  LOCATION_ITEM_MESSAGE,
  STOCK_ITEM_NOT_FOUND_MESSAGE,
  WHOLE_ABOVE_ZERO_MESSAGE,
} from './stock-messages';
import { stockValueKobo } from './stock-value';

type Tx = Prisma.TransactionClient;

/** The columns a stock item is answered from. */
const STOCK_ITEM_COLUMNS = {
  id: true,
  name: true,
  kind: true,
  unit: true,
  pack: true,
  factor: true,
  minimum: true,
  menuItemId: true,
  active: true,
  version: true,
} satisfies Prisma.StockItemSelect;

type StockItemRow = Prisma.StockItemGetPayload<{
  select: typeof STOCK_ITEM_COLUMNS;
}>;

/** What an audit row records of a stock item: what staff read in the history. */
function auditView(item: StockItemRow) {
  return {
    name: item.name,
    unit: item.unit,
    pack: item.pack,
    factor: item.factor,
    minimum: item.minimum,
  };
}

/**
 * The locations a role may read balances for when it is not the whole
 * store's (plan §5.4, §6.1): a Bartender the Bar, a Kitchen user the
 * Kitchen. The Storekeeper and managers read any location.
 */
const SCOPED_LOCATION: Partial<Record<StaffRole, StockLocation>> = {
  [StaffRole.BARTENDER]: StockLocation.BAR,
  [StaffRole.KITCHEN]: StockLocation.KITCHEN,
};

/** The movement type for a direct issue to each destination. */
const ISSUE_TYPE = {
  [StockLocation.KITCHEN]: StockMovementType.ISSUE_TO_KITCHEN,
  [StockLocation.BAR]: StockMovementType.ISSUE_TO_BAR,
} as const;

/**
 * Stock & Requests' stock core (plan §5.4, §7.6; card C4-2): balances and
 * movements, the Storekeeper's direct issue, the stock count, the Owner's
 * Correct Balance, and stock items with their units. Requests, purchases
 * and waste are C5's.
 *
 * Every command is one transaction (A6) whose stock changes go through
 * `StockLedgerService` and whose audit row is written in it.
 */
@Injectable()
export class StockService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
    private readonly money: MoneyControlService,
  ) {}

  /**
   * `GET /staff/stock/balances`: every item the location holds, by name,
   * with its balance (a missing row is zero), the Low Stock flag and, at
   * the Bar, the drinks on unsettled Bar bills.
   */
  async balances(
    actor: StaffPrincipal,
    query: StockBalancesQuery,
  ): Promise<StockBalancePageResponse> {
    const scoped = SCOPED_LOCATION[actor.role];

    if (scoped !== undefined && scoped !== query.location) {
      throw new ForbiddenException(ROLE_REFUSED_MESSAGE);
    }

    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const location = query.location;
    const kind =
      location === StockLocation.STORE
        ? undefined
        : location === StockLocation.BAR
          ? StockKind.BAR
          : StockKind.KITCHEN;
    const where: Prisma.StockItemWhereInput = {
      ...(kind ? { kind } : {}),
      ...(query.q
        ? { name: { contains: query.q, mode: Prisma.QueryMode.insensitive } }
        : {}),
    };

    const items = await this.prisma.stockItem.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: STOCK_ITEM_COLUMNS,
    });
    const total = await this.prisma.stockItem.count({ where });
    const ids = items.map((item) => item.id);

    const balances = await this.prisma.stockBalance.findMany({
      where: { location, stockItemId: { in: ids } },
      select: { stockItemId: true, qty: true },
    });
    const qtyOf = new Map(balances.map((b) => [b.stockItemId, b.qty]));
    const pending =
      location === StockLocation.BAR
        ? await this.pendingBarQty(ids)
        : new Map<string, number>();

    return {
      data: items.map((item) => {
        const qty = qtyOf.get(item.id) ?? 0;

        return {
          stockItemId: item.id,
          name: item.name,
          kind: item.kind,
          location,
          qty,
          unit: item.unit,
          pack: item.pack,
          factor: item.factor,
          minimum: item.minimum,
          low: isLow(location, qty, item.minimum),
          pendingQty:
            location === StockLocation.BAR ? (pending.get(item.id) ?? 0) : null,
          active: item.active,
          version: item.version,
        };
      }),
      page,
      pageSize,
      total,
    };
  }

  /**
   * The demo's `pendingQty`: the drinks on Bar bills that are Open or at
   * Payment, by paired stock item. They leave the Bar at settlement, so
   * the screen shows them under the balance. A bigint sum (plan §10).
   */
  private async pendingBarQty(
    stockItemIds: string[],
  ): Promise<Map<string, number>> {
    if (stockItemIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<
      { stockItemId: string; pending: bigint }[]
    >`
      SELECT s."id" AS "stockItemId", SUM(l."qty")::bigint AS "pending"
        FROM "OrderLine" l
        JOIN "Order" o ON o."id" = l."orderId"
        JOIN "StockItem" s ON s."menuItemId" = l."menuItemId"
       WHERE o."department" = 'BAR'
         AND o."status" IN ('OPEN', 'PAYMENT')
         AND s."id" IN (${Prisma.join(stockItemIds)})
       GROUP BY s."id"`;

    return new Map(rows.map((row) => [row.stockItemId, Number(row.pending)]));
  }

  /**
   * `GET /staff/stock/movements`: the ledger, newest first (managers and
   * the Storekeeper, plan §6.1).
   */
  async movements(
    query: StockMovementsQuery,
  ): Promise<StockMovementPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.StockMovementWhereInput = {
      ...(query.location ? { location: query.location } : {}),
      ...(query.stockItemId ? { stockItemId: query.stockItemId } : {}),
      ...(query.q
        ? {
            stockItem: {
              name: { contains: query.q, mode: Prisma.QueryMode.insensitive },
            },
          }
        : {}),
    };

    const rows = await this.prisma.stockMovement.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        createdAt: true,
        stockItemId: true,
        location: true,
        qty: true,
        type: true,
        ref: true,
        staffId: true,
        stockItem: { select: { name: true } },
        staff: { select: { name: true } },
      },
    });
    const total = await this.prisma.stockMovement.count({ where });

    return {
      data: rows.map((row) => ({
        id: row.id,
        at: row.createdAt.toISOString(),
        stockItemId: row.stockItemId,
        stockItemName: row.stockItem.name,
        location: row.location,
        qty: row.qty,
        type: row.type,
        ref: row.ref,
        staffId: row.staffId,
        staffName: row.staff?.name ?? null,
      })),
      page,
      pageSize,
      total,
    };
  }

  /**
   * `stock.issue`: the Storekeeper sends whole packs from the Store to the
   * Kitchen or the Bar without a request. The Store loses the packs; the
   * destination gains packs × "How Many in One" (plan §7.6). Runs inside
   * the idempotency service's transaction.
   */
  async issue(
    tx: Tx,
    actor: StaffPrincipal,
    request: StockIssueRequest,
    ipAddress: string,
  ): Promise<StockIssueResponse> {
    const item = await tx.stockItem.findUnique({
      where: { id: request.stockItemId },
      select: { id: true, kind: true, factor: true },
    });

    if (item === null || !locationHolds(item.kind, request.location)) {
      throw new BadRequestException(ISSUE_ITEM_MESSAGE);
    }

    const units = request.qty * item.factor;

    if (units > INT4_MAX) {
      throw new BadRequestException(WHOLE_ABOVE_ZERO_MESSAGE);
    }

    const ref = request.note || 'Direct issue';
    const storeQty = await this.ledger.move(tx, {
      stockItemId: item.id,
      location: StockLocation.STORE,
      qty: -request.qty,
      type: ISSUE_TYPE[request.location],
      ref,
      staffId: actor.id,
    });
    const destinationQty = await this.ledger.move(tx, {
      stockItemId: item.id,
      location: request.location,
      qty: units,
      type: StockMovementType.STOCK_RECEIVED,
      ref,
      staffId: actor.id,
    });

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'stock.issue',
        ref: item.id,
        after: {
          location: request.location,
          packs: request.qty,
          units,
          note: request.note || null,
        },
        ipAddress,
      },
      tx,
    );

    return {
      stockItemId: item.id,
      location: request.location,
      packs: request.qty,
      units,
      storeQty: storeQty ?? 0,
      destinationQty: destinationQty ?? 0,
    };
  }

  /**
   * `stock.count`: record what was counted at one location. Only the
   * differences from the recorded balances are written, as Stock Count
   * movements (plan §7.6).
   *
   * - The Storekeeper counts the Store; managers count any location.
   * - The balances are locked while they are read and moved, so a sale or
   *   an issue landing mid-count cannot be counted over.
   * - **Q28's default:** the differences are valued as waste is valued
   *   (`stockValueKobo`) and checked like a money decision: above the Owner
   *   Approval Limit only the Owner may record them, and the value counts
   *   toward the Daily Approval Limit. A count with no difference decides
   *   nothing and is never limited.
   */
  async count(
    actor: StaffPrincipal,
    request: StockCountRequest,
    ipAddress: string,
  ): Promise<StockCountResponse> {
    const storekeeperAtStore =
      actor.role === StaffRole.STOREKEEPER &&
      request.location === StockLocation.STORE;

    if (!isManager(actor.role) && !storekeeperAtStore) {
      throw new ForbiddenException(COUNT_ROLE_MESSAGE);
    }

    return this.prisma.$transaction(async (tx) => {
      const ids = request.counts.map((line) => line.stockItemId);
      const items = await tx.stockItem.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          kind: true,
          factor: true,
          menuItemId: true,
        },
      });
      const byId = new Map(items.map((item) => [item.id, item]));

      for (const line of request.counts) {
        const item = byId.get(line.stockItemId);

        if (item === undefined) {
          throw new NotFoundException(STOCK_ITEM_NOT_FOUND_MESSAGE);
        }

        if (!locationHolds(item.kind, request.location)) {
          throw new BadRequestException(LOCATION_ITEM_MESSAGE);
        }
      }

      const recorded = await this.ledger.lockBalances(
        tx,
        ids,
        request.location,
      );

      const changes: StockCountChangeResponse[] = [];
      let valueKobo = 0;

      for (const line of request.counts) {
        const item = byId.get(line.stockItemId);
        if (item === undefined) continue;

        const before = recorded.get(item.id) ?? 0;
        const difference = line.counted - before;

        if (difference === 0) continue;

        changes.push({
          stockItemId: item.id,
          name: item.name,
          recorded: before,
          counted: line.counted,
          difference,
        });
        valueKobo += await stockValueKobo(tx, item, difference);
      }

      if (changes.length > 0) {
        await this.money.withinLimit(tx, actor, {
          amountKobo: valueKobo,
          what: LIMITED_DECISIONS.stockCount,
          count: true,
          action: 'stock.count',
          ref: request.location,
        });
      }

      const ref = request.reason || 'Stock count';

      for (const change of changes) {
        await this.ledger.move(tx, {
          stockItemId: change.stockItemId,
          location: request.location,
          qty: change.difference,
          type: StockMovementType.STOCK_COUNT,
          ref,
          staffId: actor.id,
        });
      }

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'stock.count',
          ref: request.location,
          after: {
            location: request.location,
            changes: changes.map((change) => ({
              item: change.name,
              recorded: change.recorded,
              counted: change.counted,
              difference: change.difference,
            })),
          },
          reason: request.reason ?? null,
          ipAddress,
        },
        tx,
      );

      return { location: request.location, changes };
    });
  }

  /**
   * `stock.adjust` (Correct Balance): the Owner adds or removes a whole
   * number at one location, with a reason (plan §6.2: O + r). Every other
   * role is refused with the Owner sentence, as the demo refuses it before
   * anything else. Runs inside the idempotency service's transaction.
   */
  assertMayAdjust(actor: StaffPrincipal): void {
    this.money.ownerOnly(actor, OWNER_ONLY_ACTIONS.correctStockBalance);
  }

  async adjust(
    tx: Tx,
    actor: StaffPrincipal,
    request: StockAdjustRequest,
    ipAddress: string,
  ): Promise<StockAdjustResponse> {
    this.assertMayAdjust(actor);

    const item = await tx.stockItem.findUnique({
      where: { id: request.stockItemId },
      select: { id: true, kind: true },
    });

    if (item === null || !locationHolds(item.kind, request.location)) {
      throw new BadRequestException(LOCATION_ITEM_MESSAGE);
    }

    const qty =
      request.direction === StockAdjustDirection.REMOVE
        ? -request.qty
        : request.qty;
    const balance = await this.ledger.move(tx, {
      stockItemId: item.id,
      location: request.location,
      qty,
      type: StockMovementType.ADMIN_ADJUSTMENT,
      ref: request.reason,
      staffId: actor.id,
    });

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'stock.adjust',
        ref: item.id,
        after: { location: request.location, qty },
        reason: request.reason,
        ipAddress,
      },
      tx,
    );

    return {
      stockItemId: item.id,
      location: request.location,
      qty,
      balance: balance ?? 0,
    };
  }

  /**
   * `stockitem.create`: a new Kitchen item (managers). It starts at zero
   * everywhere. Bar items are never made here: each is the pair of a Bar
   * menu item, made with it by `menu.save`.
   */
  async createItem(
    actor: StaffPrincipal,
    request: CreateStockItemRequest,
    ipAddress: string,
  ): Promise<StockItemResponse> {
    return this.prisma
      .$transaction(async (tx) => {
        await assertStockNameFree(tx, request.name);

        const item = await tx.stockItem.create({
          data: {
            name: request.name,
            kind: StockKind.KITCHEN,
            unit: request.unit,
            pack: request.pack,
            factor: request.factor,
            minimum: request.minimum,
          },
          select: STOCK_ITEM_COLUMNS,
        });

        await this.audit.record(
          {
            actor: staffActor(actor),
            action: 'stockitem.create',
            ref: item.id,
            after: auditView(item),
            ipAddress,
          },
          tx,
        );

        return item;
      })
      .catch(rethrowStockNameClash);
  }

  /**
   * `stockitem.save` (Units): a manager changes how an item is bought and
   * used, with a reason. Balances are not rescaled: the Store keeps its
   * packs, the Kitchen and Bar their units (D40); the screen warns.
   */
  async saveItem(
    actor: StaffPrincipal,
    id: string,
    request: UpdateStockItemRequest,
    ipAddress: string,
  ): Promise<StockItemResponse> {
    return this.prisma.$transaction(async (tx) => {
      await claimVersion(tx, {
        table: 'StockItem',
        id,
        version: request.version,
        notFound: STOCK_ITEM_NOT_FOUND_MESSAGE,
      });

      const current = await tx.stockItem.findUniqueOrThrow({
        where: { id },
        select: STOCK_ITEM_COLUMNS,
      });
      const updated = await tx.stockItem.update({
        where: { id },
        data: {
          unit: request.unit,
          pack: request.pack,
          factor: request.factor,
          minimum: request.minimum,
        },
        select: STOCK_ITEM_COLUMNS,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'stockitem.save',
          ref: id,
          before: auditView(current),
          after: auditView(updated),
          reason: request.reason,
          ipAddress,
        },
        tx,
      );

      return updated;
    });
  }
}
