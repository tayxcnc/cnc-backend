import { Department, OrderStatus } from '../../generated/cnc-client';
import {
  balanceDueKobo,
  departmentShares,
  orderTotals,
  totalsFromSubtotal,
} from './order-totals';

describe('orderTotals (the demo’s totals())', () => {
  const bill = (
    lines: { qty: number; unitPriceKobo: number }[],
    extra: Partial<{
      discountKobo: number;
      depositKobo: number;
      vatBps: number;
      serviceBps: number;
    }> = {},
  ) =>
    orderTotals({
      lines,
      discountKobo: 0,
      depositKobo: 0,
      vatBps: 750,
      serviceBps: 0,
      ...extra,
    });

  it('adds VAT at 7.5% on the subtotal', () => {
    // The demo's options test: 4 × ₦7,500 = ₦30,000.
    expect(bill([{ qty: 4, unitPriceKobo: 750000 }])).toEqual({
      subtotalKobo: 3000000,
      discountKobo: 0,
      serviceKobo: 0,
      vatKobo: 225000,
      totalKobo: 3225000,
      dueKobo: 3225000,
    });
  });

  it('charges service on the discounted subtotal and VAT on both', () => {
    const totals = bill([{ qty: 2, unitPriceKobo: 100000 }], {
      discountKobo: 50000,
      serviceBps: 1000,
    });

    // base 150000; service 15000; VAT 7.5% of 165000 = 12375.
    expect(totals).toMatchObject({
      subtotalKobo: 200000,
      discountKobo: 50000,
      serviceKobo: 15000,
      vatKobo: 12375,
      totalKobo: 177375,
    });
  });

  it('rounds each figure to the kobo as Math.round does', () => {
    // 7.5% of 333 kobo is 24.975, which rounds to 25.
    expect(bill([{ qty: 1, unitPriceKobo: 333 }]).vatKobo).toBe(25);
    // 7.5% of 10 kobo is 0.75, which rounds to 1; 6 kobo gives 0.45, 0.
    expect(bill([{ qty: 1, unitPriceKobo: 10 }]).vatKobo).toBe(1);
    expect(bill([{ qty: 1, unitPriceKobo: 6 }]).vatKobo).toBe(0);
  });

  it('never discounts more than the subtotal', () => {
    expect(
      bill([{ qty: 1, unitPriceKobo: 1000 }], { discountKobo: 5000 }),
    ).toMatchObject({ discountKobo: 1000, totalKobo: 0, dueKobo: 0 });
  });

  it('takes reservation credit off the total, never below zero', () => {
    const lines = [{ qty: 1, unitPriceKobo: 100000 }];

    expect(bill(lines, { depositKobo: 7500 }).dueKobo).toBe(100000);
    expect(bill(lines, { depositKobo: 500000 }).dueKobo).toBe(0);
  });

  it('is all zeros for a bill with no lines', () => {
    expect(bill([])).toMatchObject({ totalKobo: 0, dueKobo: 0 });
  });
});

describe('balanceDueKobo (the demo’s balanceDue)', () => {
  it('is the due amount less what was paid, never below zero', () => {
    expect(balanceDueKobo(OrderStatus.PAYMENT, 10000, 4000)).toBe(6000);
    expect(balanceDueKobo(OrderStatus.OPEN, 10000, 12000)).toBe(0);
  });

  it('is zero on a settled or cancelled bill', () => {
    expect(balanceDueKobo(OrderStatus.SETTLED, 10000, 0)).toBe(0);
    expect(balanceDueKobo(OrderStatus.CANCELLED, 10000, 0)).toBe(0);
  });
});

describe('totalsFromSubtotal and departmentShares (the Sales report, C8-1)', () => {
  const rates = {
    discountKobo: 0,
    depositKobo: 0,
    vatBps: 750,
    serviceBps: 0,
  };

  it('computes what orderTotals computes from the summed lines', () => {
    const lines = [
      { qty: 2, unitPriceKobo: 450_000 },
      { qty: 3, unitPriceKobo: 133_333 },
    ];
    const withRates = { ...rates, discountKobo: 70_001, serviceBps: 1000 };

    expect(totalsFromSubtotal(1_299_999, withRates)).toEqual(
      orderTotals({ lines, ...withRates }),
    );
  });

  it('gives a one-department bill wholly to that department, a drinks-only web order to the Bar', () => {
    expect(
      departmentShares(
        { ...rates, department: Department.RESTAURANT },
        new Map([[Department.BAR, 1_000_000]]),
      ),
    ).toEqual([
      {
        department: Department.BAR,
        netItemsKobo: 1_000_000,
        serviceKobo: 0,
        vatKobo: 75_000,
        totalKobo: 1_075_000,
      },
    ]);
    expect(
      departmentShares(
        { ...rates, department: Department.RESTAURANT },
        new Map(),
      ),
    ).toEqual([
      {
        department: Department.RESTAURANT,
        netItemsKobo: 0,
        serviceKobo: 0,
        vatKobo: 0,
        totalKobo: 0,
      },
    ]);
  });

  it('splits a mixed bill so the shares add up to the bill to the kobo', () => {
    const bill = {
      ...rates,
      discountKobo: 10_001,
      serviceBps: 1000,
      department: Department.RESTAURANT,
    };
    const subtotals = new Map([
      [Department.RESTAURANT, 333_333],
      [Department.BAR, 166_667],
    ]);
    const whole = totalsFromSubtotal(500_000, bill);
    const shares = departmentShares(bill, subtotals);
    const sum = (
      key: 'netItemsKobo' | 'serviceKobo' | 'vatKobo' | 'totalKobo',
    ) => shares.reduce((n, share) => n + share[key], 0);

    expect(shares.map((share) => share.department)).toEqual([
      Department.RESTAURANT,
      Department.BAR,
    ]);
    // The Bar's own lines at the bill's rates, with its share of the
    // discount: round(10,001 × 166,667 / 500,000) = 3,334.
    expect(shares[1]).toEqual({
      department: Department.BAR,
      ...(() => {
        const bar = totalsFromSubtotal(166_667, {
          ...bill,
          discountKobo: 3334,
        });

        return {
          netItemsKobo: bar.subtotalKobo - bar.discountKobo,
          serviceKobo: bar.serviceKobo,
          vatKobo: bar.vatKobo,
          totalKobo: bar.totalKobo,
        };
      })(),
    });
    expect(sum('netItemsKobo')).toBe(whole.subtotalKobo - whole.discountKobo);
    expect(sum('serviceKobo')).toBe(whole.serviceKobo);
    expect(sum('vatKobo')).toBe(whole.vatKobo);
    expect(sum('totalKobo')).toBe(whole.totalKobo);
  });
});
