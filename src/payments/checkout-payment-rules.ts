import { CheckoutStatus } from '../../generated/cnc-client';
import { formatKobo } from '../common/money';
import { PAYSTACK_CURRENCY, type VerifiedTransaction } from './paystack-client';

/**
 * The checkout states a confirmed payment may still settle (plan §7.4,
 * §5.5): waiting, abandoned past its expiry (a late payment is still
 * money taken), or refused at initialize (Paystack may yet have opened
 * the page). `PAID`, `NEEDS_ATTENTION` and `RESOLVED` are final for the
 * webhook: a replay or a second event changes none of them.
 */
export const SETTLEABLE_CHECKOUT_STATUSES: CheckoutStatus[] = [
  CheckoutStatus.PENDING,
  CheckoutStatus.EXPIRED,
  CheckoutStatus.FAILED,
];

/**
 * Why a paid checkout is held when its customer deleted their account
 * before the payment arrived (Q36): for CNC's inbox and the managers.
 */
export const ANONYMISED_CHECKOUT_REASON =
  'The customer deleted their account before this payment arrived, so the order has no name, phone, email or address. Refund it in Paystack.';

/**
 * Whether a checkout lost its contact to an account deletion (Q36): a
 * checkout always has an email otherwise (the checkout form requires one),
 * and only the deletion writes it empty.
 */
export function isAnonymisedContact(contactEmail: string): boolean {
  return contactEmail === '';
}

/** What a checkout expects Paystack to confirm. */
export interface ExpectedPayment {
  reference: string;
  totalKobo: number;
}

/**
 * Why a signed `charge.success` does not pay its checkout, or null when it
 * does (plan §7.4 step 3, §8.3): Paystack's **verify** must answer
 * `success` for the checkout's reference with exactly its total in naira
 * (`NGN`), and the event itself must name the same amount and currency.
 * TAY's webhook checks neither; CNC checks both, so a forged or altered
 * event, a partial payment or a payment in another currency creates no
 * order. The sentence is for CNC's inbox and staff, never a customer.
 */
export function paymentMismatch(
  expected: ExpectedPayment,
  event: VerifiedTransaction | undefined,
  verified: VerifiedTransaction,
): string | null {
  if (verified.status !== 'success') {
    return `Paystack's verify answered "${verified.status}", not success.`;
  }

  if (verified.reference !== expected.reference) {
    return 'Paystack verified a different reference.';
  }

  if (verified.currency !== PAYSTACK_CURRENCY) {
    return `Paid in ${verified.currency ?? 'an unknown currency'}, not ${PAYSTACK_CURRENCY}.`;
  }

  if (verified.amountKobo !== expected.totalKobo) {
    return (
      `Paystack verified ${amountText(verified.amountKobo)}; the checkout ` +
      `asked for ${formatKobo(expected.totalKobo)}.`
    );
  }

  if (event !== undefined) {
    if (event.currency !== PAYSTACK_CURRENCY) {
      return `The event named ${event.currency ?? 'no currency'}, not ${PAYSTACK_CURRENCY}.`;
    }

    if (event.amountKobo !== expected.totalKobo) {
      return (
        `The event named ${amountText(event.amountKobo)}; the checkout ` +
        `asked for ${formatKobo(expected.totalKobo)}.`
      );
    }
  }

  return null;
}

function amountText(amountKobo: number | undefined): string {
  return amountKobo === undefined ? 'no amount' : formatKobo(amountKobo);
}
