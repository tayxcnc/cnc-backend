import { type Department, OrderStatus } from '../../generated/cnc-client';

/** What a bill's totals are computed from. */
export interface TotalsInput {
  lines: readonly { qty: number; unitPriceKobo: number }[];
  discountKobo: number;
  depositKobo: number;
  vatBps: number;
  serviceBps: number;
}

/** A bill's totals, every figure in kobo. */
export interface OrderTotals {
  subtotalKobo: number;
  /** The discount applied, never more than the subtotal. */
  discountKobo: number;
  serviceKobo: number;
  vatKobo: number;
  totalKobo: number;
  /** The total less the reservation credit used (never below zero). */
  dueKobo: number;
}

/**
 * The demo's `totals()` (`staff/lib/domain.ts`), figure for figure: service
 * on the discounted subtotal, VAT on that plus service (plan §18 Q7: "on
 * items + service at the table"), each rounded to the kobo with
 * `Math.round` as the demo rounds, and the reservation credit taken off the
 * total. Pure, so the list, the detail, the receipt and settlement (C4-5)
 * compute one bill one way.
 */
export function orderTotals(input: TotalsInput): OrderTotals {
  return totalsFromSubtotal(
    input.lines.reduce((sum, line) => sum + line.unitPriceKobo * line.qty, 0),
    input,
  );
}

/** What a bill's rates are: everything `orderTotals` reads but the lines. */
export type TotalsRates = Omit<TotalsInput, 'lines'>;

/**
 * {@link orderTotals} from a subtotal already summed (a report sums each
 * bill's lines in SQL as `bigint`, plan §10): the same rounding, the same
 * order, one formula.
 */
export function totalsFromSubtotal(
  subtotalKobo: number,
  input: TotalsRates,
): OrderTotals {
  const discountKobo = Math.min(input.discountKobo, subtotalKobo);
  const base = subtotalKobo - discountKobo;
  const serviceKobo = Math.round((base * input.serviceBps) / 10000);
  const vatKobo = Math.round(((base + serviceKobo) * input.vatBps) / 10000);
  const totalKobo = base + serviceKobo + vatKobo;

  return {
    subtotalKobo,
    discountKobo,
    serviceKobo,
    vatKobo,
    totalKobo,
    dueKobo: Math.max(0, totalKobo - input.depositKobo),
  };
}

/** One department's share of a settled bill, every figure in kobo. */
export interface DepartmentShare {
  department: Department;
  /** Items less the discount: the Sales report's "Net Items". */
  netItemsKobo: number;
  serviceKobo: number;
  vatKobo: number;
  totalKobo: number;
}

/**
 * A bill's totals split by its lines' departments (plan §10: "departments
 * are taken from each line's department, so web drinks count as Bar").
 * A bill whose lines are all one department is wholly that department's,
 * which is every till bill, and a web order of drinks only is wholly the
 * Bar's though its number is `CNCR-`.
 *
 * A bill with both (a web order) gives each department other than its own
 * the totals of its own lines, at the bill's rates, with the discount
 * shared by subtotal (rounded); the bill's own department takes the rest of
 * each figure. The shares then add up to the bill to the kobo, so the
 * report's departments always sum to its Completed Sales. A bill with no
 * lines is its own department's, worth nothing.
 */
export function departmentShares(
  bill: TotalsRates & { department: Department },
  subtotals: ReadonlyMap<Department, number>,
): DepartmentShare[] {
  const present = [...subtotals.keys()];
  const subtotalKobo = [...subtotals.values()].reduce((a, b) => a + b, 0);
  const whole = totalsFromSubtotal(subtotalKobo, bill);
  const share = (department: Department, totals: OrderTotals) => ({
    department,
    netItemsKobo: totals.subtotalKobo - totals.discountKobo,
    serviceKobo: totals.serviceKobo,
    vatKobo: totals.vatKobo,
    totalKobo: totals.totalKobo,
  });

  if (present.length <= 1) {
    return [share(present[0] ?? bill.department, whole)];
  }

  const rest = present.includes(bill.department) ? bill.department : present[0];
  const others = present
    .filter((department) => department !== rest)
    .map((department) => {
      const own = subtotals.get(department) ?? 0;
      const discount =
        subtotalKobo === 0
          ? 0
          : Math.round((whole.discountKobo * own) / subtotalKobo);

      return share(
        department,
        totalsFromSubtotal(own, { ...bill, discountKobo: discount }),
      );
    });
  const left = (key: Exclude<keyof DepartmentShare, 'department'>) =>
    share(rest, whole)[key] -
    others.reduce((sum, other) => sum + other[key], 0);

  return [
    {
      department: rest,
      netItemsKobo: left('netItemsKobo'),
      serviceKobo: left('serviceKobo'),
      vatKobo: left('vatKobo'),
      totalKobo: left('totalKobo'),
    },
    ...others,
  ];
}

/**
 * The demo's `balanceDue`: what the guest still owes, the due amount less
 * the money already received; nothing on a settled or cancelled bill.
 */
export function balanceDueKobo(
  status: OrderStatus,
  dueKobo: number,
  paidKobo: number,
): number {
  if (status === OrderStatus.SETTLED || status === OrderStatus.CANCELLED) {
    return 0;
  }

  return Math.max(0, dueKobo - paidKobo);
}
