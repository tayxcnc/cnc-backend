/**
 * Trim a free-text value.
 *
 * Non-strings are passed through untouched. It is applied through
 * `@Transform`, which runs before validation, so it is reached with whatever
 * JSON arrived; coercing here would replace a validator's clear 400 with a
 * confusing one.
 *
 * Shared in `src/common` because request bodies across every feature trim
 * their free text, and `src/common` imports nothing from a feature.
 */
export function trimText(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}
