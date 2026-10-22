import { OrderStatus } from '../../generated/cnc-client';

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
  const subtotalKobo = input.lines.reduce(
    (sum, line) => sum + line.unitPriceKobo * line.qty,
    0,
  );
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
