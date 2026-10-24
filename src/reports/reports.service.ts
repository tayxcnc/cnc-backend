import { Injectable } from '@nestjs/common';
import {
  Department,
  OrderChannel,
  PaymentMethod,
  Prisma,
} from '../../generated/cnc-client';
import { MaintenanceService } from '../assets/maintenance.service';
import { formatIsoDate } from '../common/calendar-date';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import type { ReportPeriodQuery } from '../common/dto/report-period.query';
import { reportPeriod, type ReportPeriod } from '../common/report-period';
import { watToday } from '../common/wat';
import { MENU_ORDER } from '../menu/menu.service';
import {
  balanceDueKobo,
  departmentShares,
  type DepartmentShare,
  totalsFromSubtotal,
} from '../orders/order-totals';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { StockService } from '../stock/stock.service';
import { WasteService } from '../waste/waste.service';
import type { SalesReportQuery } from './dto/reports.request';
import {
  type MaintenanceReportResponse,
  PaymentKind,
  type PaymentsReportResponse,
  type ReportPaymentResponse,
  type SalesCategoryResponse,
  type SalesItemResponse,
  type SalesOrderRowResponse,
  type SalesReportResponse,
  type StockMovementsReportResponse,
  type TransfersReportResponse,
  type VendorSpendReportResponse,
  type WasteReportResponse,
} from './dto/reports.response';

/** The four methods a payment can be, in the order the report lists them. */
const METHODS = [
  PaymentMethod.CASH,
  PaymentMethod.CARD,
  PaymentMethod.TRANSFER,
  PaymentMethod.ONLINE,
] as const;

/**
 * An instant bound into raw SQL as text and read as UTC, never a Date
 * parameter: the timestamp columns have no zone and hold UTC (*Data and
 * migrations*), and a zoned value would be cast in the session's zone.
 */
function utcInstant(at: Date): Prisma.Sql {
  return Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** A Postgres `bigint` sum as a number: exact far beyond any day's money. */
function kobo(value: bigint | number | null): number {
  return value === null ? 0 : Number(value);
}

/** The page and page size a report read asked for. */
function pageOf(query: { page?: number; pageSize?: number }) {
  return {
    page: query.page ?? DEFAULT_PAGE,
    pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
  };
}

/** The demo's Kind column: Part Payment, Online Checkout or Final Payment. */
export function paymentKind(payment: {
  part: boolean;
  method: PaymentMethod;
}): PaymentKind {
  if (payment.part) return PaymentKind.PART_PAYMENT;
  if (payment.method === PaymentMethod.ONLINE) {
    return PaymentKind.ONLINE_CHECKOUT;
  }

  return PaymentKind.FINAL_PAYMENT;
}

const PAYMENT_COLUMNS = {
  id: true,
  number: true,
  createdAt: true,
  businessDate: true,
  orderId: true,
  method: true,
  part: true,
  amountKobo: true,
  sender: true,
  reference: true,
  staffId: true,
  order: { select: { number: true } },
  staff: { select: { name: true } },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{
  select: typeof PAYMENT_COLUMNS;
}>;

function toPayment(row: PaymentRow): ReportPaymentResponse {
  return {
    id: row.id,
    number: row.number,
    at: row.createdAt.toISOString(),
    businessDate: formatIsoDate(row.businessDate),
    orderId: row.orderId,
    orderNumber: row.order.number,
    method: row.method,
    kind: paymentKind(row),
    amountKobo: row.amountKobo,
    sender: row.sender,
    reference: row.reference,
    staffId: row.staffId,
    staffName: row.staff?.name ?? null,
  };
}

/** One settled bill's lines of one department, as the Sales query sums them. */
interface SalesLineSum {
  id: string;
  number: string;
  department: Department;
  channel: OrderChannel;
  openedOn: string;
  settledAt: string;
  vatBps: number;
  serviceBps: number;
  discountKobo: number;
  depositKobo: number;
  lineDepartment: Department | null;
  subtotal: bigint;
}

/**
 * Reports (plan §5.4, §10; card C8-1): JSON over a range of Lagos business
 * dates, computed on read from the stored rows the way the staff app's
 * `reports.tsx` computes them from its local store (A20). Kitchen
 * Crosscheck (C4-6) and Cash Reconciliation (C4-7) live with their own
 * modules; the movements, waste and repairs are read through their own
 * modules' services, so a row reads the same in a report as on its screen.
 *
 * Every report pages its table as the two earlier ones do (`{ data, page,
 * pageSize, total, from, to }`), and every figure beside the table
 * (Completed Sales, Money Received, the vendors' totals) covers the whole
 * range, never only the page. Money is summed as `bigint` in SQL (plan
 * §10); a bill's VAT and service are rounded per bill by the till's own
 * formula (`totalsFromSubtotal`), as the demo rounds them.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly stock: StockService,
    private readonly wasteEntries: WasteService,
    private readonly repairs: MaintenanceService,
  ) {}

  /**
   * Sales: bills settled in the range by their Lagos settlement date
   * (`settledAt` from 00:00 on `from` to 24:00 on `to` in Jos), as the
   * demo's table shows them, oldest bill first (the demo's list); by item
   * and by category; Still Owed; and the delivery fees as their own line
   * (Q21). Departments are each line's (plan §10, D30): a web order's
   * drinks are the Bar's though its number is `CNCR-` (`departmentShares`).
   * With a department chosen, a bill appears when it has a line in it,
   * with that department's share of its figures.
   */
  async sales(query: SalesReportQuery): Promise<SalesReportResponse> {
    const { page, pageSize } = pageOf(query);
    const period = reportPeriod(query, 'The sales report');
    const department = query.department ?? null;
    const settledIn = Prisma.sql`
          o."status" = 'SETTLED'
      AND o."settledAt" >= ${utcInstant(period.start)}
      AND o."settledAt" <  ${utcInstant(period.end)}`;

    const sums = await this.prisma.$queryRaw<SalesLineSum[]>`
      SELECT o."id", o."number",
             o."department"::text AS "department",
             o."channel"::text AS "channel",
             o."businessDate"::text AS "openedOn",
             to_char(o."settledAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "settledAt",
             o."vatBps", o."serviceBps", o."discountKobo", o."depositKobo",
             l."department"::text AS "lineDepartment",
             COALESCE(SUM(l."qty"::bigint * l."unitPriceKobo"), 0)::bigint AS "subtotal"
        FROM "Order" o
        LEFT JOIN "OrderLine" l ON l."orderId" = o."id"
       WHERE ${settledIn}
       GROUP BY o."id", l."department"
       ORDER BY o."createdAt", o."id", l."department"`;

    // One bill per id, its subtotals by line department, in the bills' order.
    const bills = new Map<
      string,
      { bill: SalesLineSum; subtotals: Map<Department, number> }
    >();

    for (const sum of sums) {
      const held = bills.get(sum.id) ?? {
        bill: sum,
        subtotals: new Map<Department, number>(),
      };

      if (sum.lineDepartment !== null) {
        held.subtotals.set(sum.lineDepartment, kobo(sum.subtotal));
      }
      bills.set(sum.id, held);
    }

    const rows: SalesOrderRowResponse[] = [];
    const byDepartment = new Map<
      Department,
      { totalKobo: number; bills: number }
    >([
      [Department.RESTAURANT, { totalKobo: 0, bills: 0 }],
      [Department.BAR, { totalKobo: 0, bills: 0 }],
    ]);

    for (const { bill, subtotals } of bills.values()) {
      const shares = departmentShares(bill, subtotals);
      const shown: DepartmentShare[] =
        department === null
          ? shares
          : shares.filter((share) => share.department === department);

      if (shown.length === 0) continue;

      const figure = (key: Exclude<keyof DepartmentShare, 'department'>) =>
        shown.reduce((sum, share) => sum + share[key], 0);

      for (const share of shown) {
        const total = byDepartment.get(share.department)!;

        total.totalKobo += share.totalKobo;
        total.bills += 1;
      }

      rows.push({
        orderId: bill.id,
        number: bill.number,
        department: bill.department,
        channel: bill.channel,
        departments: shares.map((share) => share.department),
        openedOn: bill.openedOn,
        settledOn: formatIsoDate(watToday(new Date(bill.settledAt))),
        settledAt: bill.settledAt,
        netItemsKobo: figure('netItemsKobo'),
        vatKobo: figure('vatKobo'),
        serviceKobo: figure('serviceKobo'),
        totalKobo: figure('totalKobo'),
      });
    }

    const owed = await this.stillOwed(department);
    const fees = await this.prisma.$queryRaw<
      { kobo: bigint; orders: bigint }[]
    >`
      SELECT COALESCE(SUM(w."feeKobo"), 0)::bigint AS "kobo",
             COUNT(*) FILTER (WHERE w."feeKobo" > 0)::bigint AS "orders"
        FROM "OnlineOrder" w
        JOIN "Order" o ON o."id" = w."orderId"
       WHERE ${settledIn}`;

    const { byItem, byCategory } = await this.salesByItem(
      settledIn,
      department,
    );

    return {
      data: rows.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: rows.length,
      from: period.fromIso,
      to: period.toIso,
      department,
      completedSalesKobo: rows.reduce((sum, row) => sum + row.totalKobo, 0),
      settledBills: rows.length,
      departments: [...byDepartment].map(([name, total]) => ({
        department: name,
        ...total,
      })),
      vatKobo: rows.reduce((sum, row) => sum + row.vatKobo, 0),
      serviceKobo: rows.reduce((sum, row) => sum + row.serviceKobo, 0),
      stillOwedKobo: owed.kobo,
      openBills: owed.bills,
      deliveryFeesKobo: kobo(fees[0]?.kobo ?? null),
      deliveryOrders: kobo(fees[0]?.orders ?? null),
      byItem,
      byCategory,
    };
  }

  /**
   * The demo's Still Owed: every open bill (Open or Payment, any date) of
   * the department chosen, what it still owes after part payments
   * (`balanceDueKobo`), and how many there are. A bill's department is its
   * own here: open bills are the till's, one department each.
   */
  private async stillOwed(
    department: Department | null,
  ): Promise<{ kobo: number; bills: number }> {
    const open = await this.prisma.$queryRaw<
      {
        status: 'OPEN' | 'PAYMENT';
        vatBps: number;
        serviceBps: number;
        discountKobo: number;
        depositKobo: number;
        subtotal: bigint;
        paid: bigint;
      }[]
    >`
      SELECT o."status"::text AS "status", o."vatBps", o."serviceBps",
             o."discountKobo", o."depositKobo",
             COALESCE((SELECT SUM(l."qty"::bigint * l."unitPriceKobo")
                         FROM "OrderLine" l
                        WHERE l."orderId" = o."id"), 0)::bigint AS "subtotal",
             COALESCE((SELECT SUM(p."amountKobo")
                         FROM "Payment" p
                        WHERE p."orderId" = o."id"
                          AND NOT p."reversed"), 0)::bigint AS "paid"
        FROM "Order" o
       WHERE o."status" IN ('OPEN', 'PAYMENT')
         ${
           department === null
             ? Prisma.empty
             : Prisma.sql`AND o."department" = ${department}::"Department"`
         }`;

    return {
      kobo: open.reduce(
        (sum, bill) =>
          sum +
          balanceDueKobo(
            bill.status,
            totalsFromSubtotal(kobo(bill.subtotal), bill).dueKobo,
            kobo(bill.paid),
          ),
        0,
      ),
      bills: open.length,
    };
  }

  /**
   * Sales by Item and by Category: the settled bills' lines (of the
   * department chosen, by the line's department) grouped by dish, at the
   * prices sold, before order-level discounts. Dishes and categories come
   * in the menu's order (`MENU_ORDER`, the demo's menu order), with the
   * dish's name and staff category as they stand now, as the demo reads
   * them from its menu.
   */
  private async salesByItem(
    settledIn: Prisma.Sql,
    department: Department | null,
  ): Promise<{
    byItem: SalesItemResponse[];
    byCategory: SalesCategoryResponse[];
  }> {
    const sold = await this.prisma.$queryRaw<
      { menuItemId: string; qty: bigint; sales: bigint }[]
    >`
      SELECT l."menuItemId",
             SUM(l."qty")::bigint AS "qty",
             SUM(l."qty"::bigint * l."unitPriceKobo")::bigint AS "sales"
        FROM "OrderLine" l
        JOIN "Order" o ON o."id" = l."orderId"
       WHERE ${settledIn}
         ${
           department === null
             ? Prisma.empty
             : Prisma.sql`AND l."department" = ${department}::"Department"`
         }
       GROUP BY l."menuItemId"`;

    if (sold.length === 0) return { byItem: [], byCategory: [] };

    const soldOf = new Map(sold.map((row) => [row.menuItemId, row]));
    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: [...soldOf.keys()] } },
      orderBy: MENU_ORDER,
      select: {
        id: true,
        name: true,
        department: true,
        staffCategory: { select: { name: true } },
      },
    });
    const byItem = items.map((item) => ({
      menuItemId: item.id,
      name: item.name,
      category: item.staffCategory.name,
      department: item.department,
      qty: kobo(soldOf.get(item.id)!.qty),
      salesKobo: kobo(soldOf.get(item.id)!.sales),
    }));
    const categories = new Map<string, SalesCategoryResponse>();

    for (const item of byItem) {
      const category = categories.get(item.category) ?? {
        category: item.category,
        qty: 0,
        salesKobo: 0,
      };

      category.qty += item.qty;
      category.salesKobo += item.salesKobo;
      categories.set(item.category, category);
    }

    return { byItem, byCategory: [...categories.values()] };
  }

  /**
   * Payments Received: every payment dated in the range and not reversed,
   * part payments on bills still open included, newest first (the demo
   * reverses its list), with its kind and `PAY-` number; then the range's
   * Money Received, Part Payments, and each method. A refund is a
   * negative payment and counts against them, as in the demo.
   */
  async payments(query: ReportPeriodQuery): Promise<PaymentsReportResponse> {
    const { page, pageSize } = pageOf(query);
    const period = reportPeriod(query, 'The payments report');
    const where = this.paymentsIn(period);
    const rows = await this.prisma.payment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: PAYMENT_COLUMNS,
    });
    const sums = await this.prisma.$queryRaw<
      { method: PaymentMethod; part: boolean; kobo: bigint; payments: bigint }[]
    >`
      SELECT p."method"::text AS "method", p."part",
             COALESCE(SUM(p."amountKobo"), 0)::bigint AS "kobo",
             COUNT(*)::bigint AS "payments"
        FROM "Payment" p
       WHERE NOT p."reversed"
         AND p."businessDate" BETWEEN ${period.fromIso}::date AND ${period.toIso}::date
       GROUP BY p."method", p."part"`;
    const total = (rows: typeof sums) =>
      rows.reduce(
        (sum, row) => ({
          kobo: sum.kobo + kobo(row.kobo),
          payments: sum.payments + kobo(row.payments),
        }),
        { kobo: 0, payments: 0 },
      );
    const all = total(sums);
    const part = total(sums.filter((row) => row.part));

    return {
      data: rows.map(toPayment),
      page,
      pageSize,
      total: all.payments,
      from: period.fromIso,
      to: period.toIso,
      receivedKobo: all.kobo,
      payments: all.payments,
      partKobo: part.kobo,
      partPayments: part.payments,
      methods: METHODS.map((method) => {
        const one = total(sums.filter((row) => row.method === method));

        return { method, amountKobo: one.kobo, payments: one.payments };
      }),
    };
  }

  /**
   * Daily Transfers: the range's non-reversed Transfer payments, in the
   * order they were taken (the demo's list), with the `PAY-` number, the
   * sender and the reference to check against the bank app.
   */
  async transfers(query: ReportPeriodQuery): Promise<TransfersReportResponse> {
    const { page, pageSize } = pageOf(query);
    const period = reportPeriod(query, 'The transfers report');
    const where: Prisma.PaymentWhereInput = {
      ...this.paymentsIn(period),
      method: PaymentMethod.TRANSFER,
    };
    const rows = await this.prisma.payment.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: PAYMENT_COLUMNS,
    });
    const [sum] = await this.prisma.$queryRaw<
      { kobo: bigint; payments: bigint }[]
    >`
      SELECT COALESCE(SUM(p."amountKobo"), 0)::bigint AS "kobo",
             COUNT(*)::bigint AS "payments"
        FROM "Payment" p
       WHERE NOT p."reversed"
         AND p."method" = 'TRANSFER'
         AND p."businessDate" BETWEEN ${period.fromIso}::date AND ${period.toIso}::date`;

    return {
      data: rows.map(toPayment),
      page,
      pageSize,
      total: kobo(sum.payments),
      from: period.fromIso,
      to: period.toIso,
      totalKobo: kobo(sum.kobo),
    };
  }

  /** Payments taken on a business date in the range, not reversed. */
  private paymentsIn(period: ReportPeriod): Prisma.PaymentWhereInput {
    return {
      reversed: false,
      businessDate: { gte: period.from, lte: period.to },
    };
  }

  /**
   * Stock Movements: every movement made in the range (by the Jos day it
   * was made), newest first, as `GET /staff/stock/movements` reads them.
   */
  async stockMovements(
    query: ReportPeriodQuery,
  ): Promise<StockMovementsReportResponse> {
    const { page, pageSize } = pageOf(query);
    const period = reportPeriod(query, 'The stock movements report');
    const answer = await this.stock.movements(
      { page, pageSize },
      { start: period.start, end: period.end },
    );

    return { ...answer, from: period.fromIso, to: period.toIso };
  }

  /**
   * Waste: every entry logged in the range (by the Jos day it was logged),
   * oldest first, whatever its status, with that day as its Date.
   */
  async waste(query: ReportPeriodQuery): Promise<WasteReportResponse> {
    const { page, pageSize } = pageOf(query);
    const period = reportPeriod(query, 'The waste report');
    const answer = await this.wasteEntries.reportPage(
      { start: period.start, end: period.end },
      page,
      pageSize,
    );

    return {
      data: answer.data.map((entry) => ({
        ...entry,
        businessDate: formatIsoDate(watToday(new Date(entry.createdAt))),
      })),
      page,
      pageSize,
      total: answer.total,
      from: period.fromIso,
      to: period.toIso,
    };
  }

  /** Maintenance History: the repairs reported in the range, oldest first. */
  async maintenance(
    query: ReportPeriodQuery,
  ): Promise<MaintenanceReportResponse> {
    const { page, pageSize } = pageOf(query);
    const period = reportPeriod(query, 'The maintenance report');
    const answer = await this.repairs.reportPage(
      { from: period.from, to: period.to },
      page,
      pageSize,
    );

    return {
      ...answer,
      page,
      pageSize,
      from: period.fromIso,
      to: period.toIso,
    };
  }

  /**
   * Vendor Spend: every vendor, in the order they were added (the demo's
   * list, zero rows included), with what CNC received from them and their
   * repairs. Purchases Received is each Fulfilled requisition raised in
   * the range (the demo's `p.at`, the day it was raised, in Jos), by line
   * vendor: received packs × cost per pack. Maintenance Cost is the
   * repairs reported in the range. The range's totals cover every vendor.
   */
  async vendorSpend(
    query: ReportPeriodQuery,
  ): Promise<VendorSpendReportResponse> {
    const { page, pageSize } = pageOf(query);
    const period = reportPeriod(query, 'The vendor spend report');
    const vendors = await this.prisma.vendor.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    });
    const purchases = await this.prisma.$queryRaw<
      { vendorId: string; kobo: bigint }[]
    >`
      SELECT l."vendorId",
             SUM(l."receivedPacks"::bigint * l."costKobo")::bigint AS "kobo"
        FROM "PurchaseLine" l
        JOIN "Purchase" p ON p."id" = l."purchaseId"
       WHERE p."status" = 'FULFILLED'
         AND p."createdAt" >= ${utcInstant(period.start)}
         AND p."createdAt" <  ${utcInstant(period.end)}
       GROUP BY l."vendorId"`;
    const repairs = await this.prisma.$queryRaw<
      { vendorId: string; kobo: bigint }[]
    >`
      SELECT m."vendorId", SUM(m."costKobo")::bigint AS "kobo"
        FROM "MaintenanceRecord" m
       WHERE m."reportedOn" BETWEEN ${period.fromIso}::date AND ${period.toIso}::date
       GROUP BY m."vendorId"`;
    const purchasesOf = new Map(
      purchases.map((row) => [row.vendorId, kobo(row.kobo)]),
    );
    const repairsOf = new Map(
      repairs.map((row) => [row.vendorId, kobo(row.kobo)]),
    );
    const rows = vendors.map((vendor) => {
      const purchasesKobo = purchasesOf.get(vendor.id) ?? 0;
      const repairsKobo = repairsOf.get(vendor.id) ?? 0;

      return {
        vendorId: vendor.id,
        vendorName: vendor.name,
        purchasesKobo,
        repairsKobo,
        totalKobo: purchasesKobo + repairsKobo,
      };
    });
    const sum = (key: 'purchasesKobo' | 'repairsKobo' | 'totalKobo') =>
      rows.reduce((n, row) => n + row[key], 0);

    return {
      data: rows.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: rows.length,
      from: period.fromIso,
      to: period.toIso,
      purchasesKobo: sum('purchasesKobo'),
      repairsKobo: sum('repairsKobo'),
      totalKobo: sum('totalKobo'),
    };
  }
}
