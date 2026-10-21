import type { KitchenLine } from './kitchen-rules';

/**
 * The Kitchen Crosscheck (plan §7.10): the demo's `crosscheck()`
 * (`staff/lib/domain.ts`), result for result. Pure, so the report and its
 * unit spec compute the same statuses; the service only loads the rows.
 */

/** The demo's seven results, as the API spells them (A5). */
export const CrosscheckStatus = {
  MATCHED: 'MATCHED',
  MISSING_KITCHEN_ENTRY: 'MISSING_KITCHEN_ENTRY',
  REFERENCE_MISMATCH: 'REFERENCE_MISMATCH',
  REVISION_MISMATCH: 'REVISION_MISMATCH',
  MAPPING_REQUIRED: 'MAPPING_REQUIRED',
  QUANTITY_MISMATCH: 'QUANTITY_MISMATCH',
  UNMATCHED_KITCHEN_ENTRY: 'UNMATCHED_KITCHEN_ENTRY',
} as const;

export type CrosscheckStatus =
  (typeof CrosscheckStatus)[keyof typeof CrosscheckStatus];

/** The latest revision of one docket ref. */
export interface CrosscheckDocket {
  ref: string;
  orderId: string;
  orderNumber: string;
  businessDate: string;
  revision: number;
  /** The docket's dishes: a cancellation docket has none. */
  items: readonly { menuItemId: string; qty: number }[];
}

/** A kitchen entry, as the crosscheck reads it. */
export interface CrosscheckEntry {
  docketRef: string;
  orderId: string;
  orderNumber: string;
  businessDate: string;
  revision: number;
  lines: readonly KitchenLine[];
}

/** One row of the report. */
export interface CrosscheckRow {
  ref: string;
  orderId: string;
  orderNumber: string;
  businessDate: string;
  /** The docket's revision; 0 for a kitchen entry with no docket. */
  revision: number;
  /** The entry's revision, or null when the kitchen recorded nothing. */
  kitchenRevision: number | null;
  status: CrosscheckStatus;
  /** Portions the comparison rules expect, in the order they were met. */
  expected: KitchenLine[];
  /** Portions the kitchen recorded. */
  actual: KitchenLine[];
}

/**
 * Compare each docket's latest revision with its kitchen entry and the
 * dishes' comparison rules, then list the entries no docket explains.
 *
 * The status is the first that applies, in the demo's order:
 * 1. no entry: Missing kitchen entry;
 * 2. the entry belongs to another order: Reference mismatch;
 * 3. the entry was recorded against another revision: Revision mismatch;
 * 4. a dish on the docket has no rule: Mapping required (a dish without a
 *    rule is flagged, never passed);
 * 5. any portion's expected and recorded quantities differ: Quantity
 *    mismatch;
 * 6. otherwise Matched.
 *
 * Expected portions are each rule's quantity × the dish's quantity, summed
 * per portion. A cancellation docket expects nothing, so it matches only
 * an entry the kitchen cleared. Refs are compared without regard to case,
 * as the demo compares them.
 */
export function crosscheck(
  dockets: readonly CrosscheckDocket[],
  entries: readonly CrosscheckEntry[],
  rules: ReadonlyMap<string, readonly KitchenLine[]>,
): CrosscheckRow[] {
  const byRef = new Map(
    entries.map((entry) => [entry.docketRef.toUpperCase(), entry]),
  );

  const rows = dockets.map((docket): CrosscheckRow => {
    const entry = byRef.get(docket.ref.toUpperCase());
    const expected = new Map<string, number>();
    let unmapped = false;

    for (const item of docket.items) {
      const rule = rules.get(item.menuItemId);

      if (rule === undefined) {
        unmapped = true;
        continue;
      }

      for (const portion of rule) {
        expected.set(
          portion.stockItemId,
          (expected.get(portion.stockItemId) ?? 0) + portion.qty * item.qty,
        );
      }
    }

    const actual = entry?.lines ?? [];
    const recorded = (id: string) =>
      actual.find((line) => line.stockItemId === id)?.qty ?? 0;
    const mismatch = [
      ...new Set([...expected.keys(), ...actual.map((l) => l.stockItemId)]),
    ].some((id) => (expected.get(id) ?? 0) !== recorded(id));

    let status: CrosscheckStatus = CrosscheckStatus.MATCHED;

    if (entry === undefined) status = CrosscheckStatus.MISSING_KITCHEN_ENTRY;
    else if (entry.orderId !== docket.orderId) {
      status = CrosscheckStatus.REFERENCE_MISMATCH;
    } else if (entry.revision !== docket.revision) {
      status = CrosscheckStatus.REVISION_MISMATCH;
    } else if (unmapped) status = CrosscheckStatus.MAPPING_REQUIRED;
    else if (mismatch) status = CrosscheckStatus.QUANTITY_MISMATCH;

    return {
      ref: docket.ref,
      orderId: docket.orderId,
      orderNumber: docket.orderNumber,
      businessDate: docket.businessDate,
      revision: docket.revision,
      kitchenRevision: entry?.revision ?? null,
      status,
      expected: [...expected].map(([stockItemId, qty]) => ({
        stockItemId,
        qty,
      })),
      actual: actual.map((line) => ({ ...line })),
    };
  });

  const docketRefs = new Set(dockets.map((docket) => docket.ref.toUpperCase()));

  for (const entry of entries) {
    if (docketRefs.has(entry.docketRef.toUpperCase())) continue;

    rows.push({
      ref: entry.docketRef,
      orderId: entry.orderId,
      orderNumber: entry.orderNumber,
      businessDate: entry.businessDate,
      revision: 0,
      kitchenRevision: entry.revision,
      status: CrosscheckStatus.UNMATCHED_KITCHEN_ENTRY,
      expected: [],
      actual: entry.lines.map((line) => ({ ...line })),
    });
  }

  return rows;
}
