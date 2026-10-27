import {
  crosscheck,
  CrosscheckStatus,
  type CrosscheckDocket,
  type CrosscheckEntry,
} from './kitchen-crosscheck';
import type { KitchenLine } from './kitchen-rules';

const JOLLOF = 'dish-jollof';
const SOUP = 'dish-soup';
const RICE = 'portion-rice';
const CHICKEN = 'portion-chicken';

/** Jollof: one rice and one chicken per plate. Soup has no rule. */
const RULES = new Map<string, KitchenLine[]>([
  [
    JOLLOF,
    [
      { stockItemId: RICE, qty: 1 },
      { stockItemId: CHICKEN, qty: 1 },
    ],
  ],
]);

const docket = (
  overrides: Partial<CrosscheckDocket> = {},
): CrosscheckDocket => ({
  ref: 'KOT-CNCR-000121',
  orderId: 'order-121',
  orderNumber: 'CNCR-000121',
  businessDate: '2026-10-21',
  revision: 1,
  items: [{ menuItemId: JOLLOF, qty: 2 }],
  ...overrides,
});

const entry = (overrides: Partial<CrosscheckEntry> = {}): CrosscheckEntry => ({
  docketRef: 'KOT-CNCR-000121',
  orderId: 'order-121',
  orderNumber: 'CNCR-000121',
  businessDate: '2026-10-21',
  revision: 1,
  lines: [
    { stockItemId: RICE, qty: 2 },
    { stockItemId: CHICKEN, qty: 2 },
  ],
  ...overrides,
});

const statusOf = (
  dockets: CrosscheckDocket[],
  entries: CrosscheckEntry[],
): string[] => crosscheck(dockets, entries, RULES).map((row) => row.status);

describe('crosscheck (the demo’s seven results)', () => {
  it('matches an entry that records what the rules expect', () => {
    const [row] = crosscheck([docket()], [entry()], RULES);

    expect(row.status).toBe(CrosscheckStatus.MATCHED);
    expect(row.expected).toEqual([
      { stockItemId: RICE, qty: 2 },
      { stockItemId: CHICKEN, qty: 2 },
    ]);
    expect(row.kitchenRevision).toBe(1);
  });

  it('distinguishes missing, revision and quantity mismatches (the demo’s case)', () => {
    expect(statusOf([docket()], [])).toEqual([
      CrosscheckStatus.MISSING_KITCHEN_ENTRY,
    ]);
    expect(statusOf([docket({ revision: 2 })], [entry()])).toEqual([
      CrosscheckStatus.REVISION_MISMATCH,
    ]);
    expect(
      statusOf([docket()], [entry({ lines: [{ stockItemId: RICE, qty: 1 }] })]),
    ).toEqual([CrosscheckStatus.QUANTITY_MISMATCH]);
  });

  it('flags a portion recorded beyond what the rules expect', () => {
    expect(
      statusOf(
        [docket()],
        [
          entry({
            lines: [
              { stockItemId: RICE, qty: 2 },
              { stockItemId: CHICKEN, qty: 2 },
              { stockItemId: 'portion-plantain', qty: 1 },
            ],
          }),
        ],
      ),
    ).toEqual([CrosscheckStatus.QUANTITY_MISMATCH]);
  });

  it('flags a dish without a rule, never passes it', () => {
    expect(
      statusOf(
        [
          docket({
            items: [
              { menuItemId: JOLLOF, qty: 2 },
              { menuItemId: SOUP, qty: 1 },
            ],
          }),
        ],
        [entry()],
      ),
    ).toEqual([CrosscheckStatus.MAPPING_REQUIRED]);
  });

  it('flags an entry that belongs to another order', () => {
    expect(statusOf([docket()], [entry({ orderId: 'order-999' })])).toEqual([
      CrosscheckStatus.REFERENCE_MISMATCH,
    ]);
  });

  it('checks in the demo’s order: reference, revision, rule, quantity', () => {
    // Everything wrong at once answers the first problem only.
    expect(
      statusOf(
        [docket({ revision: 2, items: [{ menuItemId: SOUP, qty: 1 }] })],
        [entry({ orderId: 'order-999', lines: [] })],
      ),
    ).toEqual([CrosscheckStatus.REFERENCE_MISMATCH]);
    expect(
      statusOf(
        [docket({ revision: 2, items: [{ menuItemId: SOUP, qty: 1 }] })],
        [entry({ lines: [] })],
      ),
    ).toEqual([CrosscheckStatus.REVISION_MISMATCH]);
    expect(
      statusOf(
        [docket({ items: [{ menuItemId: SOUP, qty: 1 }] })],
        [entry({ lines: [] })],
      ),
    ).toEqual([CrosscheckStatus.MAPPING_REQUIRED]);
  });

  it('matches a cancellation docket only to an entry the kitchen cleared', () => {
    const cancelled = docket({ revision: 2, items: [] });

    expect(statusOf([cancelled], [entry({ revision: 2, lines: [] })])).toEqual([
      CrosscheckStatus.MATCHED,
    ]);
    expect(statusOf([cancelled], [entry({ revision: 2 })])).toEqual([
      CrosscheckStatus.QUANTITY_MISMATCH,
    ]);
  });

  it('compares refs without regard to case, as the demo does', () => {
    expect(
      statusOf([docket()], [entry({ docketRef: 'kot-cncr-000121' })]),
    ).toEqual([CrosscheckStatus.MATCHED]);
  });

  it('lists an entry no docket explains after the dockets', () => {
    const rows = crosscheck(
      [docket()],
      [
        entry(),
        entry({
          docketRef: 'KOT-CNCR-000999',
          orderId: 'order-999',
          orderNumber: 'CNCR-000999',
          revision: 3,
        }),
      ],
      RULES,
    );

    expect(rows.map((row) => [row.ref, row.status])).toEqual([
      ['KOT-CNCR-000121', CrosscheckStatus.MATCHED],
      ['KOT-CNCR-000999', CrosscheckStatus.UNMATCHED_KITCHEN_ENTRY],
    ]);
    expect(rows[1]).toMatchObject({ revision: 0, kitchenRevision: 3 });
    expect(rows[1].expected).toEqual([]);
  });

  it('sums a portion shared by several dishes', () => {
    const rules = new Map<string, KitchenLine[]>([
      ...RULES,
      [SOUP, [{ stockItemId: RICE, qty: 3 }]],
    ]);
    const [row] = crosscheck(
      [
        docket({
          items: [
            { menuItemId: JOLLOF, qty: 2 },
            { menuItemId: SOUP, qty: 1 },
          ],
        }),
      ],
      [],
      rules,
    );

    expect(row.expected).toEqual([
      { stockItemId: RICE, qty: 5 },
      { stockItemId: CHICKEN, qty: 2 },
    ]);
  });
});
