import type { PaidCard, VerifiedTransaction } from './paystack-client';
import {
  asRecord,
  dateAt,
  integerAt,
  objectAt,
  stringAt,
} from './payload-readers';

/**
 * A Paystack transaction object (verify's `data`, or a `charge.success`
 * event's `data`) narrowed to what CNC reads, or undefined when it is not
 * an object with a `status`. Every other field is read on its own and is
 * absent when Paystack did not send it in the expected shape, so the
 * amount check meets "absent" and refuses, never a guess.
 */
export function readTransaction(
  value: unknown,
): VerifiedTransaction | undefined {
  const data = asRecord(value);

  if (data === undefined) return undefined;

  const status = stringAt(data, 'status');

  if (status === undefined) return undefined;

  return {
    status,
    reference: stringAt(data, 'reference'),
    amountKobo: integerAt(data, 'amount'),
    currency: stringAt(data, 'currency'),
    paidAt: dateAt(data, 'paid_at') ?? dateAt(data, 'paidAt'),
    card: readCard(data),
  };
}

/**
 * The card behind a charge: its type and last four digits only (plan
 * §8.5), or undefined when the charge was not a card (a transfer, USSD) or
 * the authorization does not carry both.
 */
function readCard(data: Record<string, unknown>): PaidCard | undefined {
  const authorization = objectAt(data, 'authorization');

  if (authorization === undefined) return undefined;

  const type = stringAt(authorization, 'card_type')?.trim();
  const last4 = stringAt(authorization, 'last4');

  if (type === undefined || type === '' || last4 === undefined) {
    return undefined;
  }

  return /^\d{4}$/.test(last4) ? { type, last4 } : undefined;
}

/** The card brands a receipt names, by the first word of `card_type`. */
const CARD_BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  verve: 'Verve',
  amex: 'American Express',
};

/**
 * The brand as the confirmation page and the receipt name it ("Visa"),
 * from Paystack's `card_type` ("visa ", "mastercard DEBIT"): the website's
 * demo said "Visa ending 4242". An unknown brand is "Card".
 */
export function cardBrandName(cardType: string): string {
  const first = cardType.trim().split(/\s+/)[0]?.toLowerCase() ?? '';

  return CARD_BRANDS[first] ?? 'Card';
}

/** "Visa ending 4242", or null when no card paid. */
export function cardText(
  brand: string | null,
  last4: string | null,
): string | null {
  return brand === null || last4 === null ? null : `${brand} ending ${last4}`;
}
