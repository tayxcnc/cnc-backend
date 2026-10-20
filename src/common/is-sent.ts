/**
 * Whether an optional field was sent at all, for `@ValidateIf`.
 *
 * Used in place of `@IsOptional`, which skips validation for `null` as well as
 * for an absent field. `null` is not "no choice" and not "leave it as it is":
 * it counts as sent, reaches the validators and is refused, so no service is
 * ever asked to tell an absent value from an empty one.
 *
 * Shared in `src/common` because any partial-update body has the same
 * question to answer for each of its optional fields.
 */
export function isSent(_owner: object, value: unknown): boolean {
  return value !== undefined;
}
