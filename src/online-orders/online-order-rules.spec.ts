import {
  AddressZone,
  Department,
  Fulfilment,
  OnlineOrderMode,
} from '../../generated/cnc-client';
import type { PricedLine } from '../ordering/cart-pricing';
import {
  heldToTaken,
  onlineOrderMode,
  recordedBalanceKobo,
  webDocketDate,
  webDocketItems,
  webSalePlan,
} from './online-order-rules';

const line = (over: Partial<PricedLine>): PricedLine => ({
  menuItemId: 'm-food',
  dishId: 'jollof',
  name: 'Jollof',
  option: '',
  qty: 1,
  unitPriceKobo: 500000,
  department: Department.RESTAURANT,
  ...over,
});

describe('onlineOrderMode', () => {
  it('maps pickup and the two delivery zones to the staff app’s modes', () => {
    expect(onlineOrderMode(Fulfilment.PICKUP, null)).toBe(
      OnlineOrderMode.PICKUP,
    );
    expect(onlineOrderMode(Fulfilment.DELIVERY, AddressZone.JOS)).toBe(
      OnlineOrderMode.WITHIN_JOS,
    );
    expect(onlineOrderMode(Fulfilment.DELIVERY, AddressZone.PLATEAU)).toBe(
      OnlineOrderMode.OUTSIDE_JOS,
    );
  });
});

describe('webDocketItems', () => {
  it('keeps the Restaurant lines only, in cart order', () => {
    const items = webDocketItems([
      line({ menuItemId: 'a', name: 'Suya', option: 'Beef', qty: 2 }),
      line({ menuItemId: 'd', department: Department.BAR, name: 'Zobo' }),
      line({ menuItemId: 'b', name: 'Rice' }),
    ]);

    expect(items).toEqual([
      {
        menuItemId: 'a',
        name: 'Suya',
        option: 'Beef',
        qty: 2,
        unitPriceKobo: 500000,
      },
      {
        menuItemId: 'b',
        name: 'Rice',
        option: '',
        qty: 1,
        unitPriceKobo: 500000,
      },
    ]);
  });

  it('is empty for drinks alone', () => {
    expect(webDocketItems([line({ department: Department.BAR })])).toEqual([]);
  });
});

describe('webSalePlan', () => {
  it('moves each paired drink once by the sum of its lines, in stock id order', () => {
    const plan = webSalePlan(
      [
        line({ menuItemId: 'zobo', department: Department.BAR, qty: 2 }),
        line({ menuItemId: 'food' }),
        line({
          menuItemId: 'chapman',
          department: Department.BAR,
          option: 'Large',
          qty: 1,
        }),
        line({
          menuItemId: 'zobo',
          department: Department.BAR,
          option: 'Cold',
          qty: 3,
        }),
      ],
      new Map([
        ['zobo', 'stock-b'],
        ['chapman', 'stock-a'],
      ]),
    );

    expect(plan).toEqual({
      moves: [
        { stockItemId: 'stock-a', qty: 1 },
        { stockItemId: 'stock-b', qty: 5 },
      ],
      unpaired: [],
    });
  });

  it('names an unpaired drink once and moves nothing for it', () => {
    const plan = webSalePlan(
      [
        line({ menuItemId: 'x', name: 'Mystery', department: Department.BAR }),
        line({
          menuItemId: 'x',
          name: 'Mystery',
          option: 'Big',
          department: Department.BAR,
        }),
      ],
      new Map(),
    );

    expect(plan).toEqual({ moves: [], unpaired: ['Mystery'] });
  });
});

describe('recordedBalanceKobo (what one online.balance records)', () => {
  it('records the whole balance, as the demo does', () => {
    expect(
      recordedBalanceKobo({
        balanceKobo: 500000,
        toCard: false,
        cardRefundableKobo: 0,
      }),
    ).toBe(500000);
    expect(
      recordedBalanceKobo({
        balanceKobo: -2500000,
        toCard: false,
        cardRefundableKobo: 2000000,
      }),
    ).toBe(-2500000);
    expect(
      recordedBalanceKobo({
        balanceKobo: -500000,
        toCard: true,
        cardRefundableKobo: 2000000,
      }),
    ).toBe(-500000);
  });

  it('sends a card refund only up to the card money not yet refunded, leaving the rest owed', () => {
    // ₦20,000 by card, ₦5,000 more in cash, then cancelled: ₦25,000 owed.
    expect(
      recordedBalanceKobo({
        balanceKobo: -2500000,
        toCard: true,
        cardRefundableKobo: 2000000,
      }),
    ).toBe(-2000000);
  });
});

describe('webDocketDate (the kitchen day of a web docket)', () => {
  // 12:00 in Jos on 1 and 2 May 2026 (UTC+1).
  const paidDay = new Date(Date.UTC(2026, 4, 1));

  it('is the day paid for as soon as possible', () => {
    expect(webDocketDate(null, paidDay)).toEqual(paidDay);
  });

  it('is the scheduled day for a slot tomorrow', () => {
    expect(webDocketDate(new Date(Date.UTC(2026, 4, 2, 11)), paidDay)).toEqual(
      new Date(Date.UTC(2026, 4, 2)),
    );
  });

  it('is the Lagos day of the slot, not the UTC one', () => {
    // 00:30 on 2 May in Jos is still 1 May in UTC.
    expect(
      webDocketDate(new Date(Date.UTC(2026, 4, 1, 23, 30)), paidDay),
    ).toEqual(new Date(Date.UTC(2026, 4, 2)));
  });

  it('is never before the day paid (a late payment for a past slot)', () => {
    expect(webDocketDate(new Date(Date.UTC(2026, 3, 30, 11)), paidDay)).toEqual(
      paidDay,
    );
  });
});

describe('heldToTaken (a return never more than the order took)', () => {
  it('keeps every sale, and a return within what was taken', () => {
    expect(
      heldToTaken(
        [
          { stockItemId: 'a', delta: -2 },
          { stockItemId: 'b', delta: 1 },
        ],
        new Map([['b', 3]]),
      ),
    ).toEqual({
      moves: [
        { stockItemId: 'a', delta: -2 },
        { stockItemId: 'b', delta: 1 },
      ],
      cut: [],
    });
  });

  it('returns nothing to an item the order never took from (paired after the sale)', () => {
    expect(heldToTaken([{ stockItemId: 'late', delta: 3 }], new Map())).toEqual(
      { moves: [], cut: ['late'] },
    );
  });

  it('cuts a return to what is left of the sale', () => {
    expect(
      heldToTaken([{ stockItemId: 'b', delta: 3 }], new Map([['b', 1]])),
    ).toEqual({ moves: [{ stockItemId: 'b', delta: 1 }], cut: ['b'] });
  });
});
