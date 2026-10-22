/**
 * A kitchen docket's lines (plan §4.3, §7.1): the snapshot a docket keeps
 * in `Docket.items`, the ref it prints under, and the one comparison that
 * decides whether a confirm writes a new revision or reprints the latest.
 * Pure, so the confirm, the payment check (C4-5) and the crosscheck (C4-6)
 * judge a docket the same way.
 */

/** One line as a docket keeps it: what the kitchen cooks, and what it cost. */
export interface DocketItem {
  menuItemId: string;
  name: string;
  /** `''` when the dish has no choice. */
  option: string;
  qty: number;
  unitPriceKobo: number;
}

/** The prefix every kitchen docket ref carries: `KOT-CNCR-000001`. */
export const DOCKET_REF_PREFIX = 'KOT-';

/** The docket ref for an order number (the demo's `'KOT-'+o.id`). */
export function docketRef(orderNumber: string): string {
  return `${DOCKET_REF_PREFIX}${orderNumber}`;
}

/**
 * A ref as the kitchen types it from paper, read the way the demo reads it
 * (`String(ref).trim().toUpperCase()`), so `kot-cncr-000001 ` finds
 * `KOT-CNCR-000001`.
 */
export function normaliseDocketRef(text: string): string {
  return text.trim().toUpperCase();
}

/** A line of a bill, as a docket snapshots it. */
export function docketItem(line: DocketItem): DocketItem {
  return {
    menuItemId: line.menuItemId,
    name: line.name,
    option: line.option,
    qty: line.qty,
    unitPriceKobo: line.unitPriceKobo,
  };
}

function key(item: DocketItem): string {
  return JSON.stringify([
    item.menuItemId,
    item.option,
    item.qty,
    item.name,
    item.unitPriceKobo,
  ]);
}

/**
 * Whether a bill's lines are exactly what a docket holds: the demo's
 * `JSON.stringify(o.items) === JSON.stringify(o.confirmed)`, without its
 * dependence on the order the lines were added in. Every snapshot field
 * counts, so a dish removed and added again at a new price is a change.
 */
export function sameDocketItems(
  lines: readonly DocketItem[],
  docket: readonly DocketItem[],
): boolean {
  if (lines.length !== docket.length) return false;

  const a = lines.map(key).sort();
  const b = docket.map(key).sort();

  return a.every((value, index) => value === b[index]);
}

function isDocketItem(value: unknown): value is DocketItem {
  if (typeof value !== 'object' || value === null) return false;

  const item = value as Record<string, unknown>;

  return (
    typeof item.menuItemId === 'string' &&
    typeof item.name === 'string' &&
    typeof item.option === 'string' &&
    typeof item.qty === 'number' &&
    Number.isInteger(item.qty) &&
    typeof item.unitPriceKobo === 'number' &&
    Number.isInteger(item.unitPriceKobo)
  );
}

/**
 * `Docket.items` read back from `jsonb`, checked rather than cast: a row
 * written by anything but this module (a hand repair, a later migration)
 * fails loudly here instead of printing a docket with missing dishes.
 */
export function parseDocketItems(value: unknown): DocketItem[] {
  if (!Array.isArray(value) || !value.every(isDocketItem)) {
    throw new Error(
      'A docket holds items in a shape this service cannot read.',
    );
  }

  return value.map(docketItem);
}
