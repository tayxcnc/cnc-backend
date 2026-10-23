/**
 * Reading values out of a Paystack payload without trusting it, copied
 * from TAY's `payload-readers.ts` (plan §8.2: "payload readers that never
 * throw").
 *
 * Everything here is a runtime check, never a cast. The signature proves
 * the bytes came from Paystack; it proves nothing about their shape, and
 * Paystack's payloads are documented loosely and observed to vary. Every
 * reader returns `undefined` for anything it cannot vouch for, and the
 * callers treat that as "this cannot be acted on" rather than throwing: a
 * malformed delivery that answered 500 would be redelivered for ever and
 * parse no better the tenth time.
 */

/** A plain object, or undefined. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A nested object at `key`, or undefined. */
export function objectAt(
  data: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(data[key]);
}

/** A non-empty string at `key`, or undefined. */
export function stringAt(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];

  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * An integer at `key`, or undefined. Integer specifically: every Paystack
 * amount is in kobo, and a fractional value is a payload that does not
 * mean what this code assumes, not a rounding question.
 */
export function integerAt(
  data: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = data[key];

  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

/** A date at `key`, or undefined for absent, null or unparseable values. */
export function dateAt(
  data: Record<string, unknown>,
  key: string,
): Date | undefined {
  const value = stringAt(data, key);

  if (value === undefined) return undefined;

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
