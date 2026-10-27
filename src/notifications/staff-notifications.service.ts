import { Injectable } from '@nestjs/common';
import {
  CheckoutStatus,
  Prisma,
  ReservationStatus,
  StaffRole,
  StockLocation,
  TaskStatus,
  WasteStatus,
} from '../../generated/cnc-client';
import type { StaffPrincipal } from '../auth/staff-principal';
import { isManager } from '../auth/staff-roles';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type PaginationQuery,
} from '../common/dto/pagination.query';
import { watToday } from '../common/wat';
import {
  activeOnlineOrderItem,
  checkoutAttentionItem,
  newWebDocketItem,
} from '../online-orders/online-bell-items';
import { ACTIVE_ONLINE_STATUSES } from '../online-orders/online-order-rules';
import { UNSETTLED_ORDER_STATUSES } from '../orders/order-rules';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { AWAITING_APPROVAL } from '../purchasing/purchases.service';
import type { StaffBellItem } from '../reception/free-table-reminder';
import { TableSessionsService } from '../reception/table-sessions.service';
import { pagesFor } from '../shell/staff-pages';
import { OPEN_REQUEST_STATUSES } from '../stock/stock-request-rules';
import { assignedTaskItem } from '../tasks/assigned-task-item';
import { type BellSource, listedSource, pageOfSources } from './bell-sources';
import {
  expectedArrivalItem,
  lowStockItem,
  purchaseApprovalItem,
  stockRequestItem,
  unsettledBillItem,
  wasteApprovalItem,
} from './staff-bell-items';

/** The bell's four switches (Settings → Notifications), the demo's `ALERTS`. */
interface BellAlerts {
  alertApprovals: boolean;
  alertLowStock: boolean;
  alertUnsettled: boolean;
  alertArrivals: boolean;
}

/** Oldest first, ties by id: the order the demo's lists were added in. */
const OLDEST_FIRST = [{ createdAt: 'asc' }, { id: 'asc' }] as const;

/**
 * Low stock (the demo's `isLow`, `stock-locations.ts`): every item at the
 * Store and at its own location (the Kitchen, or the Bar for a Bar item),
 * a missing balance being zero; low is under one pack at the Store and
 * under the item's reorder level elsewhere. Every item, active or not, as
 * the demo and the balances read count them.
 */
const LOW_STOCK_FROM = Prisma.sql`
  FROM "StockItem" s
  CROSS JOIN LATERAL (VALUES
    ('STORE', 0),
    ((CASE WHEN s."kind" = 'BAR' THEN 'BAR' ELSE 'KITCHEN' END), 1)
  ) AS l("location", "position")
  LEFT JOIN "StockBalance" b
         ON b."stockItemId" = s."id" AND b."location"::text = l."location"
  WHERE COALESCE(b."qty", 0)
        < (CASE WHEN l."location" = 'STORE' THEN 1 ELSE s."minimum" END)`;

/**
 * Web dockets the kitchen has food to enter for (New Web Docket): the
 * bill's current revision, with items, no kitchen entry under its ref
 * yet, on a kitchen day not closed. A closed day takes no more entries,
 * so its dockets would otherwise ring forever; a cancellation docket has
 * no items and rings nothing.
 */
const WEB_DOCKETS_FROM = Prisma.sql`
  FROM "Docket" d
  JOIN "Order" o ON o."id" = d."orderId" AND o."revision" = d."revision"
  WHERE d."channel" = 'WEB'
    AND jsonb_array_length(d."items") > 0
    AND NOT EXISTS (
      SELECT 1 FROM "KitchenEntry" k WHERE k."docketRef" = d."ref"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "KitchenDayClosed" c
      WHERE c."businessDate" = d."businessDate"
    )`;

/**
 * The staff bell (plan §9.1), computed on read and polled every 30 s by
 * every signed-in device (A20). It ports `staff/lib/notifications.ts`
 * item by item, in the demo's order:
 *
 * 1. Purchase Approval, then Waste Approval: managers, approvals alert on.
 * 2. Low Stock: managers and the Storekeeper, low-stock alert on.
 * 3. Unsettled From a Previous Day: managers and the Cashier, unsettled
 *    alert on.
 * 4. Online Order: the Cashier (C7-7).
 * 5. New Web Docket: the Kitchen and managers; Checkout Needs Attention:
 *    managers (both new in C7-7, placed after the online orders).
 * 6. Stock Request: the Storekeeper.
 * 7. Free Table Reminder: Reception and managers, no switch (C4-7).
 * 8. Expected Guest Arrival: Reception and managers, arrivals alert on.
 * 9. Assigned Task: the assignee (C5-3); while the approvals alert is on
 *    a manager is not also given a purchase's review task, because its
 *    Purchase Approval already asks for the same decision.
 *
 * A kind is offered only to a reader whose role opens its page
 * (`pagesFor`), so every item opens. The switches are read from the
 * settings row on every poll, so a change applies at the next one. Each
 * kind is counted, then only the rows the page shows are read
 * (`pageOfSources`), so a poll costs about two indexed queries a kind
 * whatever is pending.
 */
@Injectable()
export class StaffNotificationsService {
  constructor(
    private readonly tables: TableSessionsService,
    private readonly prisma: CncPrismaService,
  ) {}

  async list(
    actor: StaffPrincipal,
    query: PaginationQuery,
  ): Promise<{
    data: StaffBellItem[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const sources = await this.sourcesFor(actor, new Date());

    return {
      ...(await pageOfSources(sources, page, pageSize)),
      page,
      pageSize,
    };
  }

  /** The kinds this reader's bell carries, in the demo's order. */
  private async sourcesFor(
    actor: StaffPrincipal,
    now: Date,
  ): Promise<BellSource[]> {
    const role = actor.role;
    const manager = isManager(role);
    const alerts = await this.alerts();
    const sources: BellSource[] = [];

    if (manager && alerts.alertApprovals) {
      sources.push(this.purchaseApprovals(), this.wasteApprovals());
    }

    if (alerts.alertLowStock && (manager || role === StaffRole.STOREKEEPER)) {
      sources.push(this.lowStock());
    }

    if (alerts.alertUnsettled && (manager || role === StaffRole.CASHIER)) {
      sources.push(this.unsettledBills(now));
    }

    if (role === StaffRole.CASHIER) sources.push(this.activeOnlineOrders());

    if (manager || role === StaffRole.KITCHEN) {
      sources.push(this.newWebDockets());
    }

    if (manager) sources.push(this.heldCheckouts());

    if (role === StaffRole.STOREKEEPER) sources.push(this.stockRequests());

    if (manager || role === StaffRole.RECEPTION) {
      sources.push(
        listedSource('reception', () => this.tables.freeTableReminders(now)),
      );
    }

    if (alerts.alertArrivals && (manager || role === StaffRole.RECEPTION)) {
      sources.push(this.expectedArrivals(now));
    }

    // Every role that can open Tasks; a Waiter or Bartender is never given
    // a task, but an account whose role changed may still hold one.
    sources.push(this.assignedTasks(actor, manager && alerts.alertApprovals));

    const pages: readonly string[] = pagesFor(role);

    return sources.filter((source) => pages.includes(source.page));
  }

  private alerts(): Promise<BellAlerts> {
    return this.prisma.settings.findUniqueOrThrow({
      where: { singleton: true },
      select: {
        alertApprovals: true,
        alertLowStock: true,
        alertUnsettled: true,
        alertArrivals: true,
      },
    });
  }

  /** Requisitions awaiting a decision (the Approvals count's own filter). */
  private purchaseApprovals(): BellSource {
    return {
      page: 'purchasing',
      count: () => this.prisma.purchase.count({ where: AWAITING_APPROVAL }),
      rows: async (skip, take) =>
        (
          await this.prisma.purchase.findMany({
            where: AWAITING_APPROVAL,
            orderBy: [...OLDEST_FIRST],
            skip,
            take,
            select: { id: true, number: true, note: true },
          })
        ).map(purchaseApprovalItem),
    };
  }

  /** Write-offs awaiting a decision. */
  private wasteApprovals(): BellSource {
    const where = { status: WasteStatus.PENDING };

    return {
      page: 'waste',
      count: () => this.prisma.wasteEntry.count({ where }),
      rows: async (skip, take) =>
        (
          await this.prisma.wasteEntry.findMany({
            where,
            orderBy: [...OLDEST_FIRST],
            skip,
            take,
            select: {
              id: true,
              number: true,
              qty: true,
              location: true,
              stockItem: { select: { name: true } },
            },
          })
        ).map((row) =>
          wasteApprovalItem({ ...row, itemName: row.stockItem.name }),
        ),
    };
  }

  /**
   * Each item's Store, then its own location, items in the order they were
   * added (the demo's loop over its stock list).
   */
  private lowStock(): BellSource {
    return {
      page: 'inventory',
      count: async () => {
        const [row] = await this.prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS "count" ${LOW_STOCK_FROM}`;

        return row.count;
      },
      rows: async (skip, take) =>
        (
          await this.prisma.$queryRaw<
            {
              stockItemId: string;
              name: string;
              location: StockLocation;
              qty: number;
              unit: string;
              pack: string;
              minimum: number;
            }[]
          >`
            SELECT s."id" AS "stockItemId", s."name", l."location",
                   COALESCE(b."qty", 0)::int AS "qty",
                   s."unit", s."pack", s."minimum"
            ${LOW_STOCK_FROM}
            ORDER BY s."createdAt", s."id", l."position"
            OFFSET ${skip} LIMIT ${take}`
        ).map(lowStockItem),
    };
  }

  /** Open or Payment bills of an earlier business date than today's. */
  private unsettledBills(now: Date): BellSource {
    const where = {
      status: { in: UNSETTLED_ORDER_STATUSES },
      businessDate: { lt: watToday(now) },
    };

    return {
      page: 'pos',
      count: () => this.prisma.order.count({ where }),
      rows: async (skip, take) =>
        (
          await this.prisma.order.findMany({
            where,
            orderBy: [...OLDEST_FIRST],
            skip,
            take,
            select: { id: true, number: true, label: true },
          })
        ).map(unsettledBillItem),
    };
  }

  /**
   * The Cashier's active online orders (not completed or cancelled),
   * oldest first: a paid web order appears as soon as its payment writes
   * it.
   */
  private activeOnlineOrders(): BellSource {
    const where = { fulfilmentStatus: { in: ACTIVE_ONLINE_STATUSES } };

    return {
      page: 'online',
      count: () => this.prisma.onlineOrder.count({ where }),
      rows: async (skip, take) =>
        (
          await this.prisma.onlineOrder.findMany({
            where,
            orderBy: [...OLDEST_FIRST],
            skip,
            take,
            select: {
              id: true,
              contactName: true,
              fulfilmentStatus: true,
              order: { select: { number: true } },
            },
          })
        ).map((row) =>
          activeOnlineOrderItem({ ...row, orderNumber: row.order.number }),
        ),
    };
  }

  /** New Web Docket (`WEB_DOCKETS_FROM`), oldest first. */
  private newWebDockets(): BellSource {
    return {
      page: 'kitchen',
      count: async () => {
        const [row] = await this.prisma.$queryRaw<{ count: number }[]>`
          SELECT COUNT(*)::int AS "count" ${WEB_DOCKETS_FROM}`;

        return row.count;
      },
      rows: async (skip, take) =>
        (
          await this.prisma.$queryRaw<
            { ref: string; revision: number; scheduledFor: Date | null }[]
          >`
            SELECT d."ref", d."revision", d."scheduledFor"
            ${WEB_DOCKETS_FROM}
            ORDER BY d."createdAt" ASC, d."id" ASC
            OFFSET ${skip} LIMIT ${take}`
        ).map(newWebDocketItem),
    };
  }

  /** The managers' held checkouts (§7.4 step 3), oldest first. */
  private heldCheckouts(): BellSource {
    const where = { status: CheckoutStatus.NEEDS_ATTENTION };

    return {
      page: 'online',
      count: () => this.prisma.checkout.count({ where }),
      rows: async (skip, take) =>
        (
          await this.prisma.checkout.findMany({
            where,
            orderBy: [{ attentionAt: 'asc' }, { id: 'asc' }],
            skip,
            take,
            select: {
              id: true,
              contactName: true,
              totalKobo: true,
              attentionReason: true,
            },
          })
        ).map(checkoutAttentionItem),
    };
  }

  /** Requests the Store can still issue: Pending or Partially Issued. */
  private stockRequests(): BellSource {
    const where = { status: { in: [...OPEN_REQUEST_STATUSES] } };

    return {
      page: 'inventory',
      count: () => this.prisma.stockRequest.count({ where }),
      rows: async (skip, take) =>
        (
          await this.prisma.stockRequest.findMany({
            where,
            orderBy: [...OLDEST_FIRST],
            skip,
            take,
            select: { id: true, number: true, location: true },
          })
        ).map(stockRequestItem),
    };
  }

  /** Today's Confirmed bookings, in the order they were taken. */
  private expectedArrivals(now: Date): BellSource {
    const where = {
      businessDate: watToday(now),
      status: ReservationStatus.CONFIRMED,
    };

    return {
      page: 'reception',
      count: () => this.prisma.reservation.count({ where }),
      rows: async (skip, take) =>
        (
          await this.prisma.reservation.findMany({
            where,
            orderBy: [...OLDEST_FIRST],
            skip,
            take,
            select: { id: true, name: true, startMinutes: true, party: true },
          })
        ).map(expectedArrivalItem),
    };
  }

  /**
   * The reader's tasks not Done. `hideReviews` is the demo's rule for a
   * manager while the approvals alert is on: a task linked to a purchase
   * whose title starts "Review" is left out, since the Purchase Approval
   * item already asks for that decision.
   */
  private assignedTasks(
    actor: StaffPrincipal,
    hideReviews: boolean,
  ): BellSource {
    const where: Prisma.TaskWhereInput = {
      assignedToId: actor.id,
      status: { not: TaskStatus.DONE },
      ...(hideReviews
        ? {
            NOT: {
              purchaseId: { not: null },
              title: { startsWith: 'Review' },
            },
          }
        : {}),
    };

    return {
      page: 'tasks',
      count: () => this.prisma.task.count({ where }),
      rows: async (skip, take) =>
        (
          await this.prisma.task.findMany({
            where,
            orderBy: [...OLDEST_FIRST],
            skip,
            take,
            select: { id: true, title: true, status: true },
          })
        ).map(assignedTaskItem),
    };
  }
}
