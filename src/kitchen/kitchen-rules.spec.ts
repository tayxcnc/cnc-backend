import {
  isKitchenCorrection,
  kitchenStockChanges,
  parseKitchenLines,
  type CorrectionFacts,
} from './kitchen-rules';

const TODAY = '2026-10-21';
const YESTERDAY = '2026-10-20';

const facts = (overrides: Partial<CorrectionFacts> = {}): CorrectionFacts => ({
  entryDate: TODAY,
  docketDate: TODAY,
  today: TODAY,
  isClosed: () => false,
  ...overrides,
});

describe('isKitchenCorrection (the demo’s admin() condition)', () => {
  it('lets the kitchen record today’s docket on an open day', () => {
    expect(isKitchenCorrection(facts())).toBe(false);
    expect(isKitchenCorrection(facts({ previousDate: TODAY }))).toBe(false);
  });

  it('makes an entry dated away from its docket a correction', () => {
    expect(
      isKitchenCorrection(facts({ entryDate: YESTERDAY, docketDate: TODAY })),
    ).toBe(true);
  });

  it('makes an earlier day’s docket a correction, even on its own date', () => {
    expect(
      isKitchenCorrection(
        facts({ entryDate: YESTERDAY, docketDate: YESTERDAY }),
      ),
    ).toBe(true);
  });

  it('makes a closed day a correction', () => {
    expect(isKitchenCorrection(facts({ isClosed: (d) => d === TODAY }))).toBe(
      true,
    );
  });

  it('makes an earlier day’s entry, or a closed day’s entry, a correction', () => {
    expect(isKitchenCorrection(facts({ previousDate: YESTERDAY }))).toBe(true);
    expect(
      isKitchenCorrection(
        facts({
          previousDate: TODAY,
          isClosed: (d) => d === TODAY,
        }),
      ),
    ).toBe(true);
  });
});

describe('kitchenStockChanges', () => {
  const rice = 'item-a';
  const chicken = 'item-b';
  const plantain = 'item-c';

  it('takes a first entry’s portions', () => {
    expect(
      kitchenStockChanges(
        [],
        [
          { stockItemId: chicken, qty: 2 },
          { stockItemId: rice, qty: 3 },
        ],
      ),
    ).toEqual([
      { stockItemId: rice, delta: -3 },
      { stockItemId: chicken, delta: -2 },
    ]);
  });

  it('returns only removed portions on a correction (the demo’s case)', () => {
    // 'kitchen correction returns only removed portions, and can clear a
    // cancelled docket': rice 2 → 1 returns one; chicken 2 → 0 returns two.
    const previous = [
      { stockItemId: rice, qty: 2 },
      { stockItemId: chicken, qty: 2 },
    ];

    expect(
      kitchenStockChanges(previous, [{ stockItemId: rice, qty: 1 }]),
    ).toEqual([
      { stockItemId: rice, delta: 1 },
      { stockItemId: chicken, delta: 2 },
    ]);
    expect(kitchenStockChanges(previous, [])).toEqual([
      { stockItemId: rice, delta: 2 },
      { stockItemId: chicken, delta: 2 },
    ]);
  });

  it('takes what a correction adds and leaves unchanged items out, in id order', () => {
    expect(
      kitchenStockChanges(
        [
          { stockItemId: plantain, qty: 1 },
          { stockItemId: rice, qty: 2 },
        ],
        [
          { stockItemId: rice, qty: 2 },
          { stockItemId: plantain, qty: 3 },
          { stockItemId: chicken, qty: 1 },
        ],
      ),
    ).toEqual([
      { stockItemId: chicken, delta: -1 },
      { stockItemId: plantain, delta: -2 },
    ]);
  });
});

describe('parseKitchenLines', () => {
  it('reads stored lines', () => {
    expect(parseKitchenLines([{ stockItemId: 'a', qty: 2 }])).toEqual([
      { stockItemId: 'a', qty: 2 },
    ]);
    expect(parseKitchenLines([])).toEqual([]);
  });

  it('refuses a shape it cannot read', () => {
    for (const value of [
      null,
      {},
      [{ stockItemId: 'a' }],
      [{ stockItemId: 'a', qty: 1.5 }],
      [{ stockItemId: 'a', qty: 0 }],
      [{ itemId: 'a', qty: 1 }],
    ]) {
      expect(() => parseKitchenLines(value)).toThrow(/cannot read/);
    }
  });
});
