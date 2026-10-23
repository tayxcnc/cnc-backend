import { Department } from '../../generated/cnc-client';
import {
  type PricingMenuItem,
  cartLinesProblem,
  cartSums,
  priceCart,
} from './cart-pricing';
import {
  CART_EMPTY_MESSAGE,
  CART_LINES_MESSAGE,
  CART_QTY_MESSAGE,
  DISH_UNAVAILABLE_MESSAGE,
} from './checkout-messages';

const item = (over: Partial<PricingMenuItem>): PricingMenuItem => ({
  id: 'id-rice',
  slug: 'rice',
  name: 'Jollof Rice',
  priceKobo: 650000,
  department: Department.RESTAURANT,
  active: true,
  showOnline: true,
  choiceOptions: [],
  ...over,
});

const MENU = new Map<string, PricingMenuItem>([
  ['rice', item({})],
  [
    'pepper-soup',
    item({
      id: 'id-soup',
      slug: 'pepper-soup',
      name: 'Pepper Soup',
      priceKobo: 450000,
      choiceOptions: ['Goat', 'Fish'],
    }),
  ],
  [
    'zobo',
    item({
      id: 'id-zobo',
      slug: 'zobo',
      name: 'Zobo',
      priceKobo: 150000,
      department: Department.BAR,
    }),
  ],
  ['hidden', item({ id: 'id-hidden', slug: 'hidden', showOnline: false })],
  ['sold', item({ id: 'id-sold', slug: 'sold', active: false })],
]);

describe('cartLinesProblem', () => {
  it('answers one sentence per kind of problem', () => {
    expect(cartLinesProblem([])).toBe(CART_EMPTY_MESSAGE);
    expect(cartLinesProblem('rice')).toBe(CART_LINES_MESSAGE);
    expect(cartLinesProblem([{ qty: 1 }])).toBe(CART_LINES_MESSAGE);
    expect(cartLinesProblem([{ dishId: 'rice', qty: 0 }])).toBe(
      CART_QTY_MESSAGE,
    );
    expect(cartLinesProblem([{ dishId: 'rice', qty: 1000 }])).toBe(
      CART_QTY_MESSAGE,
    );
    expect(cartLinesProblem([{ dishId: 'rice', qty: 1.5 }])).toBe(
      CART_QTY_MESSAGE,
    );
    expect(cartLinesProblem([{ dishId: 'rice', qty: 2 }])).toBeNull();
  });
});

describe('priceCart', () => {
  it('prices from the menu, merges one dish and option, keeps options apart', () => {
    const priced = priceCart(
      [
        { dishId: 'rice', qty: 1 },
        { dishId: 'pepper-soup', option: 'Goat', qty: 1 },
        { dishId: 'rice', qty: 2 },
        { dishId: 'pepper-soup', option: 'Fish', qty: 1 },
      ],
      MENU,
    );

    expect(priced).toEqual({
      lines: [
        expect.objectContaining({
          dishId: 'rice',
          option: '',
          qty: 3,
          unitPriceKobo: 650000,
        }),
        expect.objectContaining({
          dishId: 'pepper-soup',
          option: 'Goat',
          qty: 1,
        }),
        expect.objectContaining({
          dishId: 'pepper-soup',
          option: 'Fish',
          qty: 1,
        }),
      ],
    });
  });

  it('refuses a dish not on the online menu now', () => {
    for (const dishId of ['nope', 'hidden', 'sold']) {
      expect(priceCart([{ dishId, qty: 1 }], MENU)).toEqual({
        problem: DISH_UNAVAILABLE_MESSAGE,
      });
    }
  });

  it('refuses a missing or unknown choice, and a choice on a dish without one', () => {
    const choose = { problem: 'Choose one of the options for Pepper Soup.' };

    expect(priceCart([{ dishId: 'pepper-soup', qty: 1 }], MENU)).toEqual(
      choose,
    );
    expect(
      priceCart([{ dishId: 'pepper-soup', option: 'Beef', qty: 1 }], MENU),
    ).toEqual(choose);
    expect(
      priceCart([{ dishId: 'rice', option: 'Large', qty: 1 }], MENU),
    ).toEqual({ problem: 'Choose one of the options for Jollof Rice.' });
  });

  it('refuses merged lines above 999', () => {
    expect(
      priceCart(
        [
          { dishId: 'rice', qty: 600 },
          { dishId: 'rice', qty: 400 },
        ],
        MENU,
      ),
    ).toEqual({ problem: CART_QTY_MESSAGE });
  });
});

describe('cartSums (Q33: subtotal + VAT + delivery, no Paystack charge)', () => {
  it('is the website’s totals: VAT on the subtotal, rounded, plus the fee', () => {
    const priced = priceCart(
      [
        { dishId: 'rice', qty: 2 },
        { dishId: 'zobo', qty: 1 },
      ],
      MENU,
    );

    if ('problem' in priced) throw new Error(priced.problem);

    expect(cartSums(priced.lines, 750, 500000)).toEqual({
      subtotalKobo: 1450000,
      vatKobo: 108750,
      deliveryKobo: 500000,
      totalKobo: 2058750,
    });
  });

  it('rounds VAT to the kobo as the website does', () => {
    const odd = new Map([['odd', item({ slug: 'odd', priceKobo: 333 })]]);
    const priced = priceCart([{ dishId: 'odd', qty: 1 }], odd);

    if ('problem' in priced) throw new Error(priced.problem);

    // 333 × 7.5% = 24.975 → 25.
    expect(cartSums(priced.lines, 750, 0)).toEqual({
      subtotalKobo: 333,
      vatKobo: 25,
      deliveryKobo: 0,
      totalKobo: 358,
    });
  });
});
