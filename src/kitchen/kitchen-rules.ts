/**
 * The kitchen entry's pure rules (plan §4.3; the demo's `kitchen.save`):
 * the stored lines' shape, when a save is a manager's correction, and the
 * stock each save moves. Pure, so the service and its unit spec judge an
 * entry the same way.
 */

/** One portion line of a kitchen entry, as `KitchenEntry.lines` keeps it. */
export interface KitchenLine {
  stockItemId: string;
  qty: number;
}

function isKitchenLine(value: unknown): value is KitchenLine {
  if (typeof value !== 'object' || value === null) return false;

  const line = value as Record<string, unknown>;

  return (
    typeof line.stockItemId === 'string' &&
    typeof line.qty === 'number' &&
    Number.isInteger(line.qty) &&
    line.qty > 0
  );
}

/**
 * `KitchenEntry.lines` read back from `jsonb`, checked rather than cast: a
 * row written by anything but this module (a hand repair) fails loudly
 * here instead of moving the wrong stock on its next correction.
 */
export function parseKitchenLines(value: unknown): KitchenLine[] {
  if (!Array.isArray(value) || !value.every(isKitchenLine)) {
    throw new Error(
      'A kitchen entry holds lines in a shape this service cannot read.',
    );
  }

  return value.map((line) => ({
    stockItemId: line.stockItemId,
    qty: line.qty,
  }));
}

/** What decides whether a save is a manager's correction. */
export interface CorrectionFacts {
  /** The date the entry is saved under (`YYYY-MM-DD`). */
  entryDate: string;
  /** The docket's business date. */
  docketDate: string;
  /** Today in Lagos. */
  today: string;
  /** Whether a kitchen day is closed. */
  isClosed: (date: string) => boolean;
  /** The entry's date before this save, when it already exists. */
  previousDate?: string;
}

/**
 * The demo's condition for `admin()` in `kitchen.save`: a save is a
 * manager's correction, with a reason, when the entry is dated away from
 * its docket or from today, when its day is closed, or when an existing
 * entry is from another day, from a closed day, or is being moved to a new
 * date. Anything else is the kitchen's own entry for today's docket.
 */
export function isKitchenCorrection(facts: CorrectionFacts): boolean {
  const { entryDate, docketDate, today, isClosed, previousDate } = facts;

  if (entryDate !== docketDate || entryDate !== today || isClosed(entryDate)) {
    return true;
  }

  if (previousDate === undefined) return false;

  return (
    previousDate !== today ||
    isClosed(previousDate) ||
    entryDate !== previousDate
  );
}

/** One balance change a save makes in the Kitchen. */
export interface KitchenStockChange {
  stockItemId: string;
  /** Previous qty less new qty: negative takes portions, positive returns them. */
  delta: number;
}

/**
 * The Kitchen stock a save moves: for every item on either list, the old
 * quantity less the new one (the demo's `move(iid, 'Kitchen', q1 - q2, …)`).
 * A first save takes its portions; a correction returns what was removed
 * and takes what was added; an unchanged item moves nothing and is left
 * out. In stock item id order, so two saves sharing items take their
 * balance locks in the same order and cannot deadlock.
 */
export function kitchenStockChanges(
  previous: readonly KitchenLine[],
  next: readonly KitchenLine[],
): KitchenStockChange[] {
  const ids = [
    ...new Set([...previous, ...next].map((line) => line.stockItemId)),
  ].sort();
  const qty = (lines: readonly KitchenLine[], id: string) =>
    lines.find((line) => line.stockItemId === id)?.qty ?? 0;

  return ids
    .map((stockItemId) => ({
      stockItemId,
      delta: qty(previous, stockItemId) - qty(next, stockItemId),
    }))
    .filter((change) => change.delta !== 0);
}
