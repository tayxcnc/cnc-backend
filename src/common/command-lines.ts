import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { INT4_MAX } from '../prisma/int4';

/**
 * The demo's `positiveLines` sentences (`staff/lib/domain.ts`), byte for
 * byte (A7): the item lists a command carries (a kitchen comparison rule's
 * portions, a kitchen entry's portions), and the duplicate refusal a stock
 * count shares with them.
 */
export const LINES_EMPTY_MESSAGE = 'Add at least one item.';
export const LINES_DUPLICATE_MESSAGE =
  'Combine duplicate items into one quantity.';
export const LINES_QTY_MESSAGE = 'Quantities must be whole numbers above zero.';

/** How one kind of item list is checked, and what each refusal says. */
export interface LineRules {
  /** The key naming the line's item: `stockItemId`. */
  idKey: string;
  /**
   * The refusal for a line whose item id is missing or not text; or null
   * when the command checks each line's item itself, in its own order
   * against its other fields. The demo's `positiveLines` never looks at the
   * item, so a command whose first per-line sentence is about something
   * else (`purchase.create` checks the vendor first) must not have a blank
   * item refused here ahead of it (A7).
   */
  idMessage: string | null;
  /** The key holding the line's number: `qty`, or `counted` for a count. */
  qtyKey: string;
  /** The smallest number allowed: 1 for a quantity, 0 for a count. */
  minQty: 0 | 1;
  /** The refusal for a number that is not whole or is below `minQty`. */
  qtyMessage: string;
  /** The refusal for a list that is missing or empty. */
  emptyMessage: string;
  /**
   * True when an empty list is allowed (a correction that clears a kitchen
   * entry). The command then decides whether empty is right.
   */
  allowEmpty?: boolean;
}

/** The demo's `positiveLines` over `{ stockItemId, qty }` lines. */
export const POSITIVE_STOCK_LINES: Omit<LineRules, 'idMessage'> = {
  idKey: 'stockItemId',
  qtyKey: 'qty',
  minQty: 1,
  qtyMessage: LINES_QTY_MESSAGE,
  emptyMessage: LINES_EMPTY_MESSAGE,
};

/**
 * The first thing wrong with an item list, in the demo's order (empty, then
 * duplicates, then each line's number), with the item id checked last; or
 * null when the list is well formed. A number above `INT4_MAX` is refused
 * with the line's number sentence rather than reaching Postgres as a 500.
 */
export function lineProblem(value: unknown, rules: LineRules): string | null {
  if (!Array.isArray(value)) return rules.emptyMessage;
  if (value.length === 0) return rules.allowEmpty ? null : rules.emptyMessage;

  const lines = value as unknown[];
  const isObject = (line: unknown): line is Record<string, unknown> =>
    typeof line === 'object' && line !== null && !Array.isArray(line);

  const ids = lines.map((line) => (isObject(line) ? line[rules.idKey] : ''));
  if (new Set(ids).size !== ids.length) return LINES_DUPLICATE_MESSAGE;

  for (const line of lines) {
    const qty = isObject(line) ? line[rules.qtyKey] : undefined;

    if (
      typeof qty !== 'number' ||
      !Number.isInteger(qty) ||
      qty < rules.minQty ||
      qty > INT4_MAX
    ) {
      return rules.qtyMessage;
    }
  }

  if (rules.idMessage === null) return null;

  for (const line of lines) {
    const id = isObject(line) ? line[rules.idKey] : undefined;

    if (typeof id !== 'string' || id.trim() === '') return rules.idMessage;
  }

  return null;
}

/**
 * Validate an item list with {@link lineProblem}, answering the demo's own
 * sentence.
 *
 * Deliberately not `@ValidateNested`: the ValidationPipe prefixes a nested
 * error with its path (`lines.0.…`), which would change the sentence a
 * screen shows (A7). The lines stay plain objects; a service reads only the
 * keys named here.
 */
export function ValidLines(
  rules: LineRules,
  options?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    registerDecorator({
      name: 'validLines',
      target: target.constructor,
      propertyName: String(propertyKey),
      options,
      validator: {
        validate: (value: unknown) => lineProblem(value, rules) === null,
        defaultMessage: (args?: ValidationArguments) =>
          lineProblem(args?.value, rules) ?? rules.emptyMessage,
      },
    });
  };
}
