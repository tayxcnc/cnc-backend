import { createHash } from 'node:crypto';

/**
 * JSON text for a value with every object's keys in sorted order, so two
 * values that are equal as data give the same text however their keys were
 * ordered.
 *
 * For fingerprints, never for responses. `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` are the same request; `JSON.stringify` writes them
 * differently, and a fingerprint taken from it would call a client that
 * rebuilt its body in another order a different request.
 *
 * Follows `JSON.stringify` everywhere else: arrays keep their order, an
 * `undefined` property is left out, `undefined` in an array is `null`, and a
 * value with `toJSON` (a Date) is written as that method returns.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

/** SHA-256, hex, of {@link canonicalJson}. */
export function canonicalJsonHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function') {
    return sortKeys(withToJson.toJSON());
  }

  if (Array.isArray(value)) return value.map(sortKeys);

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }

  return sorted;
}
