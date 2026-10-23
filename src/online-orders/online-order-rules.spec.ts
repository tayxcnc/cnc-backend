import {
  AddressZone,
  Department,
  Fulfilment,
  OnlineOrderMode,
} from '../../generated/cnc-client';
import type { PricedLine } from '../ordering/cart-pricing';
import {
  onlineOrderMode,
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
