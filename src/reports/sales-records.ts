import {
  Department,
  OrderChannel,
  OrderStatus,
  Prisma,
} from '../../generated/cnc-client';
import type { ReportPeriod } from '../common/report-period';
import {
  balanceDueKobo,
  totalsFromSubtotal,
  type TotalsRates,
} from '../orders/order-totals';
import type { CncPrismaService } from '../prisma/cnc-prisma.service';

/**
 * The bill reads the Sales report and the manager overview share (card
 * C8-1), so "settled in the range" and "still owed" are one query each
 * and the two screens can never disagree on a bill.
 */

/**
 * An instant bound into raw SQL as text and read as UTC, never a Date
 * parameter: the timestamp columns have no zone and hold UTC (*Data and
 * migrations*), and a zoned value would be cast in the session's zone.
 */
export function utcInstant(at: Date): Prisma.Sql {
  return Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** A Postgres `bigint` sum as a number: exact far beyond any day's money. */
export function kobo(value: bigint | number | null): number {
  return value === null ? 0 : Number(value);
}

/**
 * The bills settled in a period (alias `o`): `settledAt` from 00:00 in Jos
 * on the first date to 00:00 in Jos after the last (plan §10).
 */
export function settledIn(
  period: Pick<ReportPeriod, 'start' | 'end'>,
): Prisma.Sql {
  return Prisma.sql`
          o."status" = 'SETTLED'
      AND o."settledAt" >= ${utcInstant(period.start)}
      AND o."settledAt" <  ${utcInstant(period.end)}`;
}

/** One settled bill with its subtotals by line department. */
export interface SettledBill extends TotalsRates {
  id: string;
  number: string;
  department: Department;
  channel: OrderChannel;
  /** The business date the bill was opened on, `YYYY-MM-DD`. */
  openedOn: string;
  /** When it was settled, ISO UTC. */
  settledAt: string;
  /** Each line department's subtotal (a bigint sum); empty for no lines. */
  subtotals: Map<Department, number>;
}

/**
 * Every bill settled in the period, oldest opened first (the demo's list
 * order), each with its lines' subtotals by line department summed as
 * `bigint` (plan §10), ready for `departmentShares`. One query.
 */
export async function settledBills(
  prisma: CncPrismaService,
  period: Pick<ReportPeriod, 'start' | 'end'>,
): Promise<SettledBill[]> {
  const sums = await prisma.$queryRaw<
    (Omit<SettledBill, 'subtotals'> & {
      lineDepartment: Department | null;
      subtotal: bigint;
    })[]
  >`
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
       WHERE ${settledIn(period)}
       GROUP BY o."id", l."department"
       ORDER BY o."createdAt", o."id", l."department"`;

  const bills = new Map<string, SettledBill>();

  for (const sum of sums) {
    const { lineDepartment, subtotal, ...bill } = sum;
    const held = bills.get(bill.id) ?? { ...bill, subtotals: new Map() };

    if (lineDepartment !== null) {
      held.subtotals.set(lineDepartment, kobo(subtotal));
    }
    bills.set(bill.id, held);
  }

  return [...bills.values()];
}

/** One bill still open (Open or Payment), with what it still owes. */
export interface OpenBill {
  id: string;
  number: string;
  department: Department;
  label: string;
  /** The business date it was opened on, `YYYY-MM-DD`. */
  businessDate: string;
  status: typeof OrderStatus.OPEN | typeof OrderStatus.PAYMENT;
  /** The demo's `balanceDue`: due less non-reversed payments, never below 0. */
  balanceKobo: number;
}

/**
 * Every open bill (Open or Payment) of any date, of one department or
 * all, newest first (the overview's Open Orders order), with what it
 * still owes after part payments (`balanceDueKobo`). The demo's Still
 * Owed and Outstanding Bills both sum these. One query.
 */
export async function openBills(
  prisma: CncPrismaService,
  department: Department | null,
): Promise<OpenBill[]> {
  const open = await prisma.$queryRaw<
    (Omit<OpenBill, 'balanceKobo'> &
      TotalsRates & { subtotal: bigint; paid: bigint })[]
  >`
      SELECT o."id", o."number", o."department"::text AS "department",
             o."label", o."businessDate"::text AS "businessDate",
             o."status"::text AS "status", o."vatBps", o."serviceBps",
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
         }
       ORDER BY o."createdAt" DESC, o."id" DESC`;

  return open.map((bill) => ({
    id: bill.id,
    number: bill.number,
    department: bill.department,
    label: bill.label,
    businessDate: bill.businessDate,
    status: bill.status,
    balanceKobo: balanceDueKobo(
      bill.status,
      totalsFromSubtotal(kobo(bill.subtotal), bill).dueKobo,
      kobo(bill.paid),
    ),
  }));
}
