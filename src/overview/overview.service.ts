import { Injectable } from '@nestjs/common';
import {
  Department,
  PaymentMethod,
  Prisma,
  ReservationStatus,
  StaffRole,
  StockLocation,
  TaskStatus,
  TableSessionStatus,
} from '../../generated/cnc-client';
import type { StaffPrincipal } from '../auth/staff-principal';
import { isManager } from '../auth/staff-roles';
import { reportPeriod, type ReportPeriod } from '../common/report-period';
import { watToday } from '../common/wat';
import { KitchenCrosscheckService } from '../kitchen/kitchen-crosscheck.service';
import { departmentShares } from '../orders/order-totals';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { PurchasesService } from '../purchasing/purchases.service';
import {
  clockText,
  floorStatus,
  HOLDING_STATUSES,
} from '../reception/reservation-rules';
import {
  kobo,
  openBills,
  settledBills,
  settledIn,
  type OpenBill,
} from '../reports/sales-records';
import {
  OVERVIEW_PRESETS,
  type OverviewWidgetId,
} from '../shell/overview-preferences';
import { ShellService } from '../shell/shell.service';
import { pagesFor } from '../shell/staff-pages';
import { scopedStockLocation } from '../stock/stock-locations';
import { OPEN_REQUEST_STATUSES } from '../stock/stock-request-rules';
import { visibleTasks } from '../tasks/task-rules';
import { WasteService } from '../waste/waste.service';
import {
  AttentionKey,
  type OverviewArrivalResponse,
  type OverviewAttentionResponse,
  type OverviewBestsellerResponse,
  type OverviewDepartmentResponse,
  type OverviewLowStockResponse,
  type OverviewMethodResponse,
  type OverviewMoneyCountResponse,
  type OverviewOccupancyResponse,
  type OverviewResponse,
  type OverviewTasksResponse,
  type OverviewTrendResponse,
  type OverviewVenueResponse,
} from './dto/overview.response';
import type { OverviewQuery } from './dto/overview.query';
import {
  rangeDays,
  trendBuckets,
  trendInterval,
  trendKey,
} from './overview-trend';

/** Needs Attention's lines: the demo's labels and pages, in its order. */
const ATTENTION = [
  {
    key: AttentionKey.PURCHASES,
    label: 'Purchase Requisitions',
    page: 'approvals',
  },
  {
    key: AttentionKey.WASTE,
    label: 'Waste Awaiting Review',
    page: 'approvals',
  },
  {
    key: AttentionKey.CROSSCHECK,
    label: 'Kitchen Crosscheck',
    page: 'reports',
  },
  {
    key: AttentionKey.STOCK_REQUESTS,
    label: 'Open Stock Requests',
    page: 'inventory',
  },
  { key: AttentionKey.TASKS, label: 'Tasks in Progress', page: 'tasks' },
] as const;

/** The demo's list lengths: Open Orders 5, Low Stock 8, Tasks 6, top 5. */
const OPEN_ORDERS_SHOWN = 5;
const LOW_STOCK_SHOWN = 8;
const TASKS_SHOWN = 6;
const BESTSELLERS_SHOWN = 5;

/** Widgets that read the bills settled in the range. */
const SETTLED_WIDGETS: readonly OverviewWidgetId[] = [
  'sales',
  'trend',
  'departments',
];

/**
 * `GET /staff/overview` (plan §5.3, §10; card C8-1): the staff app's two
 * overviews, computed on read from the stored rows the way
 * `components/cnc/overview.tsx` and `lib/overview.ts` compute them from
 * the demo's store (A20).
 *
 * **Managers and the Owner** get the full overview over `from`…`to`, but
 * only the widgets their saved layout shows (`ShellService`'s layout,
 * the Service preset when none is saved): a hidden widget is `null` and
 * costs no query. **Every other role** gets the staff overview, today
 * only, whatever range is asked: the Service preset's eight widgets, with
 * plan §6.1's row filters (a Bartender's bills are the Bar's; Kitchen sees
 * its entries today in place of sales; Needs Attention lists only lines
 * whose page the role opens, counting what that page would show it).
 *
 * Polled every 60 seconds by several managers, so every widget is a fixed
 * number of queries whatever the data (no query per row), run one after
 * another on one pooled connection at a time, so a poll never holds the
 * till's connections. Money is summed as `bigint` in SQL; each bill's
 * total is the till's own rounding (`departmentShares`, over
 * `totalsFromSubtotal`).
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly shell: ShellService,
    private readonly crosscheck: KitchenCrosscheckService,
    private readonly purchases: PurchasesService,
    private readonly waste: WasteService,
  ) {}

  async read(
    actor: StaffPrincipal,
    query: OverviewQuery,
  ): Promise<OverviewResponse> {
    const now = new Date();
    const manager = isManager(actor.role);
    // Staff roles see today only: their overview has no period (the demo's
    // staff `Overview` reads today's date).
    const period = reportPeriod(manager ? query : {}, 'The overview', now);
    const widgets: OverviewWidgetId[] = manager
      ? (await this.shell.overviewPreferences(actor)).widgets
          .filter((widget) => widget.visible)
          .map((widget) => widget.id)
      : [...OVERVIEW_PRESETS.Service];
    const shows = (id: OverviewWidgetId) => widgets.includes(id);
    // Plan §6.1: a Bartender's overview is the Bar's.
    const department =
      actor.role === StaffRole.BARTENDER ? Department.BAR : null;
    const kitchen = actor.role === StaffRole.KITCHEN;
    const today = watToday(now);

    const settled = SETTLED_WIDGETS.some(
      (id) => shows(id) && !(id === 'sales' && kitchen),
    )
      ? await this.settledFigures(period, department)
      : null;

    const open =
      shows('outstanding') || shows('orders')
        ? await openBills(this.prisma, department)
        : null;

    const floor =
      shows('occupancy') || shows('service')
        ? await this.floor(today, shows('service'))
        : null;

    const bookings =
      shows('arrivals') || shows('nextArrivals')
        ? await this.arrivals(today)
        : null;

    return {
      from: period.fromIso,
      to: period.toIso,
      scope: manager ? 'FULL' : 'BASIC',
      widgets,
      sales: shows('sales') && !kitchen ? settled!.sales : null,
      kitchenEntries:
        shows('sales') && kitchen
          ? await this.prisma.kitchenEntry.count({
              where: { businessDate: today },
            })
          : null,
      outstanding: shows('outstanding') ? outstanding(open!) : null,
      occupancy: shows('occupancy') ? floor!.occupancy : null,
      arrivals: shows('arrivals') ? bookings!.length : null,
      trend: shows('trend') ? settled!.trend : null,
      departments: shows('departments') ? settled!.departments : null,
      payments: shows('payments') ? await this.methods(period) : null,
      bestsellers: shows('bestsellers') ? await this.bestsellers(period) : null,
      service: shows('service') ? floor!.venues : null,
      attention: shows('attention') ? await this.attention(actor) : null,
      orders: shows('orders')
        ? open!.slice(0, OPEN_ORDERS_SHOWN).map((bill) => ({
            orderId: bill.id,
            number: bill.number,
            businessDate: bill.businessDate,
            department: bill.department,
            label: bill.label,
            status: bill.status,
            balanceKobo: bill.balanceKobo,
          }))
        : null,
      nextArrivals: shows('nextArrivals') ? bookings! : null,
      stock: shows('stock') ? await this.lowStock() : null,
      tasks: shows('tasks') ? await this.tasks(actor) : null,
    };
  }

  /**
   * Settled Sales, the Sales Trend and Restaurant and Bar Sales: the bills
   * settled in the range by their Lagos settlement date (the demo's
   * `sold`). A bill's total includes VAT and service and excludes the
   * delivery fee (Q21). Departments are each line's (`departmentShares`,
   * as the Sales report splits them, D30), so the two add up to Settled
   * Sales and agree with the report. With a department (the Bartender's
   * Bar), a bill counts when it has a line in it, by that share.
   */
  private async settledFigures(
    period: ReportPeriod,
    department: Department | null,
  ): Promise<{
    sales: OverviewMoneyCountResponse;
    trend: OverviewTrendResponse;
    departments: OverviewDepartmentResponse[];
  }> {
    const bills = await settledBills(this.prisma, period);
    const interval = trendInterval(rangeDays(period.fromIso, period.toIso));
    const points = trendBuckets(period.fromIso, period.toIso, interval);
    const point = new Map(points.map((bucket) => [bucket.key, bucket]));
    const byDepartment = new Map<Department, number>([
      [Department.RESTAURANT, 0],
      [Department.BAR, 0],
    ]);
    let totalKobo = 0;
    let orders = 0;

    for (const bill of bills) {
      const shares = departmentShares(bill, bill.subtotals);
      const counted =
        department === null
          ? shares
          : shares.filter((share) => share.department === department);

      if (counted.length === 0) continue;

      const amount = counted.reduce((sum, share) => sum + share.totalKobo, 0);

      totalKobo += amount;
      orders += 1;

      for (const share of counted) {
        byDepartment.set(
          share.department,
          byDepartment.get(share.department)! + share.totalKobo,
        );
      }

      const bucket = point.get(trendKey(new Date(bill.settledAt), interval));

      if (bucket !== undefined) bucket.amountKobo += amount;
    }

    return {
      sales: { totalKobo, orders },
      trend: { interval, points },
      departments: [...byDepartment].map(([name, amountKobo]) => ({
        department: name,
        amountKobo,
      })),
    };
  }

  /**
   * Payment Methods: the money received on the bills settled in the range,
   * by method, from the non-reversed payments dated in the range (the
   * demo's `ids.has(p.orderRef)` and `businessDate(p.at)`), refunds
   * (negative) included, delivery fees included (they are in a web
   * payment), reservation credit excluded (it is not a payment). Methods
   * in the order their first payment was taken, as the demo's `Map` keeps
   * them.
   */
  private async methods(
    period: ReportPeriod,
  ): Promise<OverviewMethodResponse[]> {
    const rows = await this.prisma.$queryRaw<
      { method: PaymentMethod; kobo: bigint }[]
    >`
      SELECT p."method"::text AS "method",
             SUM(p."amountKobo")::bigint AS "kobo"
        FROM "Payment" p
        JOIN "Order" o ON o."id" = p."orderId"
       WHERE NOT p."reversed"
         AND p."businessDate" BETWEEN ${period.fromIso}::date AND ${period.toIso}::date
         AND ${settledIn(period)}
       GROUP BY p."method"
       ORDER BY MIN(p."createdAt"), p."method"`;

    return rows.map((row) => ({
      method: row.method,
      amountKobo: kobo(row.kobo),
    }));
  }

  /**
   * Bestselling Items: the top five dishes by quantity on the bills
   * settled in the range, each under the name it was first sold by in the
   * range (the demo keeps the first line's name), ties by name.
   */
  private async bestsellers(
    period: ReportPeriod,
  ): Promise<OverviewBestsellerResponse[]> {
    const rows = await this.prisma.$queryRaw<
      { menuItemId: string; name: string; qty: bigint }[]
    >`
      SELECT l."menuItemId",
             (array_agg(l."name" ORDER BY o."createdAt", o."id", l."createdAt", l."id"))[1] AS "name",
             SUM(l."qty")::bigint AS "qty"
        FROM "OrderLine" l
        JOIN "Order" o ON o."id" = l."orderId"
       WHERE ${settledIn(period)}
       GROUP BY l."menuItemId"`;

    return rows
      .map((row) => ({
        menuItemId: row.menuItemId,
        name: row.name,
        qty: kobo(row.qty),
      }))
      .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name))
      .slice(0, BESTSELLERS_SHOWN);
  }

  /**
   * Occupied Positions and Service at a Glance: every active table now,
   * as Reception's floor shows it today (`floorStatus`: Locked, Occupied,
   * Reserved by a Confirmed or Checked In booking today, else Available),
   * counted by room in the floor's room order.
   */
  private async floor(
    today: Date,
    withVenues: boolean,
  ): Promise<{
    occupancy: OverviewOccupancyResponse;
    venues: OverviewVenueResponse[];
  }> {
    const tables = await this.prisma.diningTable.findMany({
      where: { active: true },
      select: { id: true, venueId: true },
    });
    const sessions = await this.prisma.tableSession.findMany({
      where: { endedAt: null, table: { active: true } },
      select: { tableId: true, status: true },
    });
    const occupancy = {
      occupied: sessions.filter(
        (session) => session.status === TableSessionStatus.OCCUPIED,
      ).length,
      tables: tables.length,
    };

    if (!withVenues) return { occupancy, venues: [] };

    const venues = await this.prisma.venue.findMany({
      orderBy: [{ sort: 'asc' }, { slug: 'asc' }],
      select: { id: true, slug: true, staffName: true },
    });
    const booked = await this.prisma.reservation.findMany({
      where: { businessDate: today, status: { in: HOLDING_STATUSES } },
      distinct: ['tableId'],
      select: { tableId: true },
    });
    const bookedTables = new Set(booked.map((row) => row.tableId));
    const sessionOf = new Map(sessions.map((row) => [row.tableId, row.status]));

    return {
      occupancy,
      venues: venues.map((venue) => {
        const counts = { available: 0, occupied: 0, reserved: 0, locked: 0 };

        for (const table of tables) {
          if (table.venueId !== venue.id) continue;

          const status = floorStatus({
            session: sessionOf.get(table.id) ?? null,
            isToday: true,
            booked: bookedTables.has(table.id),
          });

          counts[status.toLowerCase() as keyof typeof counts] += 1;
        }

        return {
          venueId: venue.id,
          slug: venue.slug,
          name: venue.staffName,
          ...counts,
        };
      }),
    };
  }

  /**
   * Expected Arrivals and Next Arrivals: today's Confirmed bookings, by
   * time (the demo's `arrivals`), without the guest's phone or email.
   */
  private async arrivals(today: Date): Promise<OverviewArrivalResponse[]> {
    const rows = await this.prisma.reservation.findMany({
      where: { businessDate: today, status: ReservationStatus.CONFIRMED },
      orderBy: [{ startMinutes: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        number: true,
        startMinutes: true,
        name: true,
        party: true,
        status: true,
        table: { select: { name: true } },
      },
    });

    return rows.map((row) => ({
      reservationId: row.id,
      number: row.number,
      time: clockText(row.startMinutes),
      name: row.name,
      tableName: row.table.name,
      party: row.party,
      status: row.status,
    }));
  }

  /**
   * Needs Attention: the demo's five lines, each only for a reader whose
   * role opens the line's page, and each counting what that page would
   * show them. Purchase Requisitions and Waste Awaiting Review are the
   * Approvals screen's (managers); Kitchen Crosscheck is every date's rows
   * that are not Matched (managers: the report is theirs alone); Open
   * Stock Requests are Pending or Partially Issued, of a Bartender's or
   * Kitchen user's own location; Tasks in Progress are those not Done
   * that the reader sees on Tasks (`visibleTasks`).
   */
  private async attention(
    actor: StaffPrincipal,
  ): Promise<OverviewAttentionResponse[]> {
    const manager = isManager(actor.role);
    const pages: readonly string[] = pagesFor(actor.role);
    const counts: Partial<Record<AttentionKey, () => Promise<number>>> = {
      ...(manager
        ? {
            [AttentionKey.PURCHASES]: () => this.purchases.pendingCount(),
            [AttentionKey.WASTE]: () => this.waste.pendingCount(),
            [AttentionKey.CROSSCHECK]: () => this.crosscheck.notMatchedCount(),
          }
        : {}),
      [AttentionKey.STOCK_REQUESTS]: () => {
        const location = scopedStockLocation(actor.role);

        return this.prisma.stockRequest.count({
          where: {
            status: { in: [...OPEN_REQUEST_STATUSES] },
            ...(location === undefined ? {} : { location }),
          },
        });
      },
      [AttentionKey.TASKS]: () =>
        this.prisma.task.count({
          where: {
            AND: [visibleTasks(actor), { status: { not: TaskStatus.DONE } }],
          },
        }),
    };
    const items: OverviewAttentionResponse[] = [];

    for (const line of ATTENTION) {
      const count = counts[line.key];

      if (count === undefined || !pages.includes(line.page)) continue;

      items.push({ ...line, count: await count() });
    }

    return items;
  }

  /**
   * Low Stock: every Kitchen item's Kitchen balance and Bar item's Bar
   * balance below its minimum (a missing balance is zero), lowest first,
   * ties in the order the items were added (the demo's stable sort over
   * its stock list); the first eight and how many there are.
   */
  private async lowStock(): Promise<OverviewLowStockResponse> {
    const rows = await this.prisma.$queryRaw<
      {
        stockItemId: string;
        name: string;
        location: StockLocation;
        qty: number;
        unit: string;
        minimum: number;
      }[]
    >`
      SELECT s."id" AS "stockItemId", s."name",
             (CASE WHEN s."kind" = 'BAR' THEN 'BAR' ELSE 'KITCHEN' END) AS "location",
             COALESCE(b."qty", 0) AS "qty", s."unit", s."minimum"
        FROM "StockItem" s
        LEFT JOIN "StockBalance" b
               ON b."stockItemId" = s."id"
              AND b."location"::text = (CASE WHEN s."kind" = 'BAR' THEN 'BAR' ELSE 'KITCHEN' END)
       WHERE COALESCE(b."qty", 0) < s."minimum"
       ORDER BY COALESCE(b."qty", 0), s."createdAt", s."id"`;

    return { data: rows.slice(0, LOW_STOCK_SHOWN), total: rows.length };
  }

  /**
   * Tasks in Progress: the tasks not Done (every one, for a manager), the
   * six oldest first (the demo's list order), with the assignee's name.
   */
  private async tasks(actor: StaffPrincipal): Promise<OverviewTasksResponse> {
    const where: Prisma.TaskWhereInput = {
      AND: [visibleTasks(actor), { status: { not: TaskStatus.DONE } }],
    };
    const rows = await this.prisma.task.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: TASKS_SHOWN,
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        assignedTo: { select: { name: true } },
      },
    });

    return {
      data: rows.map((row) => ({
        taskId: row.id,
        number: row.number,
        title: row.title,
        assignedToName: row.assignedTo.name,
        status: row.status,
      })),
      total: await this.prisma.task.count({ where }),
    };
  }
}

/** Outstanding Bills: what every open bill still owes, and how many. */
function outstanding(bills: readonly OpenBill[]): OverviewMoneyCountResponse {
  return {
    totalKobo: bills.reduce((sum, bill) => sum + bill.balanceKobo, 0),
    orders: bills.length,
  };
}
