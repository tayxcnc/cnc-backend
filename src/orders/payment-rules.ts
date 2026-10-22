import { PaymentMethod } from '../../generated/cnc-client';
import {
  PART_PAY_LESS_MESSAGE,
  PAYMENT_METHOD_MESSAGE,
  PAYMENT_MISSING_MESSAGE,
  PAYMENT_POSITIVE_MESSAGE,
  PAYMENT_TEXT_MAX_LENGTH,
  SETTLE_EXACT_MESSAGE,
  TRANSFER_DETAILS_MESSAGE,
} from './order-messages';

/**
 * The till's payment rules that need no database, ported from the demo's
 * `order.partPay` and `order.settle` (`staff/lib/domain.ts`). Pure, so a
 * unit test pins each sentence and the order the demo checks them in.
 */

/** The methods a till takes (plan §7.3). `ONLINE` is Paystack's alone (C7). */
export const TILL_METHODS: readonly PaymentMethod[] = [
  PaymentMethod.CASH,
  PaymentMethod.CARD,
  PaymentMethod.TRANSFER,
];

/** One payment as the till sends it; read only by these keys. */
export interface TillPaymentInput {
  method?: unknown;
  amountKobo?: unknown;
  sender?: unknown;
  reference?: unknown;
}

/** One payment once the rules have passed it, ready to record. */
export interface TillPayment {
  method: PaymentMethod;
  amountKobo: number;
  /** Trimmed; `""` when not given. */
  sender: string;
  /** Trimmed; `""` when not given. */
  reference: string;
}

/** What a list of payments is judged against. */
export type PaymentTarget =
  /** `order.partPay`: something, and less than the balance. */
  | { kind: 'part'; balanceKobo: number }
  /** `order.settle`: exactly what is left to pay. */
  | { kind: 'settle'; remainingKobo: number };

/** A payment's text field, trimmed; anything that is not text is blank. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The sum the demo's `reduce` makes. A value that is not a number makes it
 * `NaN`, which fails every comparison, so the sum's sentence answers it as
 * the demo's would.
 */
function sumOf(payments: readonly TillPaymentInput[]): number {
  return payments.reduce<number>(
    (sum, payment) =>
      sum +
      (typeof payment.amountKobo === 'number'
        ? payment.amountKobo
        : Number.NaN),
    0,
  );
}

/**
 * Judge a list of till payments as the demo does, and either return the
 * one sentence that refuses it or the payments ready to record:
 *
 * 1. A part payment needs at least one payment ("Payment information is
 *    missing."); a settlement may have none, when nothing is left to pay
 *    (a bill discounted to zero).
 * 2. The sum: a part payment above zero and below the balance; a
 *    settlement exactly the remaining balance.
 * 3. Then each payment in turn: a whole amount above zero, Cash, Card or
 *    Transfer, and a transfer's sender and reference.
 *
 * Beyond the demo, a sender or reference longer than
 * {@link PAYMENT_TEXT_MAX_LENGTH} is refused, so a column never holds an
 * essay. Every refusal is a 400: the request is wrong for the bill.
 */
export function judgePayments(
  payments: readonly TillPaymentInput[],
  target: PaymentTarget,
): { problem: string } | { payments: TillPayment[] } {
  const sum = sumOf(payments);

  if (target.kind === 'part') {
    if (payments.length === 0) return { problem: PAYMENT_MISSING_MESSAGE };

    if (!(sum > 0 && sum < target.balanceKobo)) {
      return { problem: PART_PAY_LESS_MESSAGE };
    }
  } else if (sum !== target.remainingKobo) {
    return { problem: SETTLE_EXACT_MESSAGE };
  }

  const ready: TillPayment[] = [];

  for (const payment of payments) {
    const amount = payment.amountKobo;

    if (
      typeof amount !== 'number' ||
      !Number.isInteger(amount) ||
      amount <= 0
    ) {
      return { problem: PAYMENT_POSITIVE_MESSAGE };
    }

    const method = TILL_METHODS.find((known) => known === payment.method);

    if (method === undefined) return { problem: PAYMENT_METHOD_MESSAGE };

    const sender = text(payment.sender);
    const reference = text(payment.reference);

    if (method === PaymentMethod.TRANSFER && (!sender || !reference)) {
      return { problem: TRANSFER_DETAILS_MESSAGE };
    }

    if (sender.length > PAYMENT_TEXT_MAX_LENGTH) {
      return {
        problem: `sender must be ${PAYMENT_TEXT_MAX_LENGTH} characters or fewer.`,
      };
    }

    if (reference.length > PAYMENT_TEXT_MAX_LENGTH) {
      return {
        problem: `reference must be ${PAYMENT_TEXT_MAX_LENGTH} characters or fewer.`,
      };
    }

    ready.push({ method, amountKobo: amount, sender, reference });
  }

  return { payments: ready };
}
