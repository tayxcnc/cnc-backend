import {
  docketRef,
  normaliseDocketRef,
  parseDocketItems,
  sameDocketItems,
  type DocketItem,
} from './docket-items';

const rice: DocketItem = {
  menuItemId: 'dish-1',
  name: 'Jollof Rice',
  option: '',
  qty: 2,
  unitPriceKobo: 650000,
};
const pancakes: DocketItem = {
  menuItemId: 'dish-2',
  name: 'Pancakes',
  option: 'Suya beef',
  qty: 1,
  unitPriceKobo: 750000,
};

describe('docket refs', () => {
  it('prints KOT- and the order number', () => {
    expect(docketRef('CNCR-000001')).toBe('KOT-CNCR-000001');
  });

  it('reads a ref typed from paper as the demo reads it', () => {
    expect(normaliseDocketRef('  kot-cncr-000001 ')).toBe('KOT-CNCR-000001');
  });
});

describe('sameDocketItems (whether a confirm is a reprint)', () => {
  it('matches the same lines in any order', () => {
    expect(sameDocketItems([rice, pancakes], [pancakes, rice])).toBe(true);
  });

  it('sees a quantity, an option, a price, an added or a removed line', () => {
    expect(sameDocketItems([{ ...rice, qty: 3 }], [rice])).toBe(false);
    expect(
      sameDocketItems([{ ...pancakes, option: 'Sweet' }], [pancakes]),
    ).toBe(false);
    expect(sameDocketItems([{ ...rice, unitPriceKobo: 700000 }], [rice])).toBe(
      false,
    );
    expect(sameDocketItems([rice, pancakes], [rice])).toBe(false);
    expect(sameDocketItems([rice], [rice, pancakes])).toBe(false);
  });

  it('treats no lines against no docket as the same', () => {
    expect(sameDocketItems([], [])).toBe(true);
  });
});

describe('parseDocketItems', () => {
  it('reads the stored snapshot and keeps only its fields', () => {
    expect(parseDocketItems([{ ...rice, extra: 'ignored' }])).toEqual([rice]);
  });

  it('refuses a shape it cannot read rather than print a short docket', () => {
    expect(() => parseDocketItems([{ ...rice, qty: '2' }])).toThrow();
    expect(() => parseDocketItems({ items: [] })).toThrow();
  });
});
