/**
 * The two long dashes: U+2013 (en dash) and U+2014 (em dash).
 *
 * The founder does not want either anywhere a person reads CNC's text,
 * because they read as machine written (G2 of the platform fixes, decision
 * P17). A hyphen is not one of them: "Walk-in", "7-a-side" and
 * `CNCR-000005` are ordinary words and references.
 *
 * One pattern for the field check below and the optional stored-text
 * report (`scripts/report-long-dashes.ts`), so the two cannot disagree on
 * what a long dash is.
 */
export const LONG_DASH = /[–—]/;

/**
 * The one sentence a refused field answers: CS B4's words, kept as the
 * brief gives them. It names no field because the staff app shows it under
 * the form it came from.
 */
export const NO_LONG_DASHES_MESSAGE =
  'Please rewrite this without long dashes.';

/** Whether `value` is text holding a long dash. Anything else is not. */
export function hasLongDash(value: unknown): boolean {
  return typeof value === 'string' && LONG_DASH.test(value);
}

/**
 * A field's own check, then the long-dash check, for `@Checked`
 * (`checked.ts`): `@Checked(noLongDashes(requiredText(...)))`.
 *
 * **Why a combinator and not another decorator.** Every failing decorator
 * adds its own message and the staff app joins every message of a 400
 * into what the screen shows (*Errors* in `docs/conventions.md`), so a
 * second decorator would answer a blank name twice. Here the field's own
 * sentence comes first, and the dash sentence only for a value that is
 * otherwise good: each field still answers one sentence.
 *
 * **Where it goes, and where it never goes (decision P18).** Menu items
 * (name, description, photo alt) and vendors: text staff write into the
 * catalogue. Never on staff notes, reasons, tasks, customer input or
 * business details: iPadOS Smart Punctuation turns a typed "--" into a long
 * dash, so refusing it there would block daily work. Those are cleaned when
 * the app shows them (`cleanCopy()` in the frontends).
 */
export function noLongDashes(
  problem: (value: unknown) => string | null,
): (value: unknown) => string | null {
  return (value) =>
    problem(value) ?? (hasLongDash(value) ? NO_LONG_DASHES_MESSAGE : null);
}
