/**
 * Turning stored kobo into something a person reads.
 *
 * Money is an integer number of kobo everywhere in this project — the schema
 * says so, the API transports it that way, and nothing divides it until the
 * moment it is displayed. This is that moment, and it is the only one: a
 * second copy of this function is a second place for a menu price to come out
 * a hundred times too large.
 *
 * Shared rather than living beside one caller, because every sentence the
 * server writes about money needs it: an order confirmation a customer keeps,
 * and the plain-language audit line that says what a change did. Returning a
 * pre-formatted figure means a client cannot render `4000000` into a page by
 * forgetting to divide.
 */

/** The naira sign, U+20A6. */
export const NAIRA = '₦';

/**
 * Format a kobo integer for display: `4000000` becomes `₦40,000.00`.
 *
 * Always two decimal places, even for a whole number of naira. A receipt or a
 * payment confirmation is a financial record and `₦40,000` reads like an
 * approximation where `₦40,000.00` reads like a figure — and the two-decimal
 * form is what anyone reconciling against a bank statement expects to see.
 *
 * The grouping separators come from `Intl`, and the sign is prepended rather
 * than obtained by asking `Intl` for NGN currency formatting. That is
 * deliberate: the currency formatter's output for NGN differs by ICU build,
 * producing `₦40,000.00` on one runtime and `NGN 40,000.00` on another, so the
 * naira sign would be present or absent depending on which Node image
 * happened to be running. Prepending it is not a workaround — it is the only
 * way to make the output the same everywhere.
 *
 * Negative amounts format with the sign before the symbol, `-₦500.00`, which
 * is the conventional reading. A refund is the obvious first negative, and
 * this should not have to be revisited when it arrives.
 */
export function formatKobo(amountKobo: number): string {
  if (!Number.isInteger(amountKobo)) {
    // Never rounded quietly. A fractional kobo means an integer column has been
    // read as something else somewhere upstream, and printing a rounded figure
    // would hide it behind a number that looks plausible.
    throw new Error(
      `Cannot format ${amountKobo} as money: amounts are integer kobo.`,
    );
  }

  const naira = Math.abs(amountKobo) / 100;
  const formatted = new Intl.NumberFormat('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(naira);

  return `${amountKobo < 0 ? '-' : ''}${NAIRA}${formatted}`;
}

/**
 * Format a kobo integer the way the staff app's `money()` does
 * (`staff/lib/domain.ts`): whole naira with no decimals, otherwise two.
 * `5000000` is `₦50,000`, `5000050` is `₦50,000.50`, `-50000` is `-₦500`.
 *
 * For sentences ported from the staff app byte for byte (A7): the approval
 * limit refusals print a limit inside the message ("…above the Owner
 * Approval Limit of ₦50,000. The Owner must approve it."), and the screens
 * show the message as it stands, so the figure must be the one the staff
 * app printed. The audit sentences use it too, so one screen never shows a
 * price two ways. A receipt or a payment confirmation uses `formatKobo`.
 *
 * The staff app asks `Intl` for NGN currency formatting; this prepends the
 * sign instead, for the reason `formatKobo` gives (the currency output
 * differs by ICU build). A unit test pins the outputs against the staff
 * app's for the same amounts.
 */
export function formatKoboShort(amountKobo: number): string {
  if (!Number.isInteger(amountKobo)) {
    throw new Error(
      `Cannot format ${amountKobo} as money: amounts are integer kobo.`,
    );
  }

  const digits = amountKobo % 100 === 0 ? 0 : 2;
  const formatted = new Intl.NumberFormat('en-NG', {
    minimumFractionDigits: digits,
    maximumFractionDigits: 2,
  }).format(Math.abs(amountKobo) / 100);

  return `${amountKobo < 0 ? '-' : ''}${NAIRA}${formatted}`;
}

/**
 * A kobo integer as a plain naira decimal: `400000` becomes `4000.00`.
 *
 * For a spreadsheet cell, not a sentence — no sign and no grouping, so the
 * cell opens as a number that can be added up, and a comma never splits it
 * across two columns. A negative keeps its minus: `-50000` is `-500.00`, a
 * gap of five hundred naira missing.
 *
 * Built from the integer's own digits rather than by dividing, so no float is
 * ever formatted; and loud about a non-integer for the reason `formatKobo` is.
 */
export function koboToNairaDecimal(amountKobo: number): string {
  if (!Number.isInteger(amountKobo)) {
    throw new Error(
      `Cannot format ${amountKobo} as money: amounts are integer kobo.`,
    );
  }

  const kobo = Math.abs(amountKobo);
  const naira = Math.floor(kobo / 100);
  const remainder = String(kobo % 100).padStart(2, '0');

  return `${amountKobo < 0 ? '-' : ''}${naira}.${remainder}`;
}
