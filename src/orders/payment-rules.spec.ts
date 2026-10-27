import { PaymentMethod } from '../../generated/cnc-client';
import {
  PART_PAY_LESS_MESSAGE,
  PAYMENT_METHOD_MESSAGE,
  PAYMENT_MISSING_MESSAGE,
  PAYMENT_POSITIVE_MESSAGE,
  SETTLE_EXACT_MESSAGE,
  TRANSFER_DETAILS_MESSAGE,
} from './order-messages';
import { judgePayments, type PaymentTarget } from './payment-rules';

const part = (balanceKobo: number): PaymentTarget => ({
  kind: 'part',
  balanceKobo,
});
const settle = (remainingKobo: number): PaymentTarget => ({
  kind: 'settle',
  remainingKobo,
});

const problemOf = (result: ReturnType<typeof judgePayments>) =>
  'problem' in result ? result.problem : null;

describe('judgePayments', () => {
  describe('a part payment', () => {
    it('needs at least one payment', () => {
      expect(problemOf(judgePayments([], part(100)))).toBe(
        PAYMENT_MISSING_MESSAGE,
      );
    });

    it('must be above zero and less than the balance', () => {
      for (const amountKobo of [0, 100, 150]) {
        expect(
          problemOf(judgePayments([{ method: 'CASH', amountKobo }], part(100))),
        ).toBe(PART_PAY_LESS_MESSAGE);
      }

      expect(
        problemOf(
          judgePayments([{ method: 'CASH', amountKobo: 99 }], part(100)),
        ),
      ).toBeNull();
    });

    it('answers an amount that is not a number with the sum’s sentence, as the demo does', () => {
      expect(
        problemOf(
          judgePayments([{ method: 'CASH', amountKobo: '50' }], part(100)),
        ),
      ).toBe(PART_PAY_LESS_MESSAGE);
    });
  });

  describe('a settlement', () => {
    it('must cover the remaining balance exactly', () => {
      expect(
        problemOf(
          judgePayments([{ method: 'CASH', amountKobo: 99 }], settle(100)),
        ),
      ).toBe(SETTLE_EXACT_MESSAGE);
      expect(
        problemOf(
          judgePayments([{ method: 'CASH', amountKobo: 101 }], settle(100)),
        ),
      ).toBe(SETTLE_EXACT_MESSAGE);
    });

    it('takes no payments when nothing is left to pay, and needs one otherwise', () => {
      expect(judgePayments([], settle(0))).toEqual({ payments: [] });
      expect(problemOf(judgePayments([], settle(100)))).toBe(
        SETTLE_EXACT_MESSAGE,
      );
    });

    it('records a split as its exact components', () => {
      expect(
        judgePayments(
          [
            { method: 'CASH', amountKobo: 10000 },
            { method: 'CARD', amountKobo: 90000, reference: ' SLIP-1 ' },
          ],
          settle(100000),
        ),
      ).toEqual({
        payments: [
          {
            method: PaymentMethod.CASH,
            amountKobo: 10000,
            sender: '',
            reference: '',
          },
          {
            method: PaymentMethod.CARD,
            amountKobo: 90000,
            sender: '',
            reference: 'SLIP-1',
          },
        ],
      });
    });
  });

  describe('each payment, after the sum', () => {
    it('is a whole amount above zero', () => {
      for (const amounts of [
        [150, -50],
        [99.5, 0.5],
      ]) {
        expect(
          problemOf(
            judgePayments(
              amounts.map((amountKobo) => ({ method: 'CASH', amountKobo })),
              settle(100),
            ),
          ),
        ).toBe(PAYMENT_POSITIVE_MESSAGE);
      }
    });

    it('is Cash, Card or Transfer; online money is Paystack’s', () => {
      for (const method of ['ONLINE', 'Cash', 'CHEQUE', undefined]) {
        expect(
          problemOf(judgePayments([{ method, amountKobo: 100 }], settle(100))),
        ).toBe(PAYMENT_METHOD_MESSAGE);
      }
    });

    it('needs a transfer’s sender and reference', () => {
      for (const details of [
        {},
        { sender: 'Ada' },
        { reference: 'REF1' },
        { sender: '  ', reference: 'REF1' },
      ]) {
        expect(
          problemOf(
            judgePayments(
              [{ method: 'TRANSFER', amountKobo: 100, ...details }],
              settle(100),
            ),
          ),
        ).toBe(TRANSFER_DETAILS_MESSAGE);
      }

      expect(
        judgePayments(
          [
            {
              method: 'TRANSFER',
              amountKobo: 100,
              sender: ' Ada ',
              reference: 'REF1',
            },
          ],
          settle(100),
        ),
      ).toEqual({
        payments: [
          {
            method: PaymentMethod.TRANSFER,
            amountKobo: 100,
            sender: 'Ada',
            reference: 'REF1',
          },
        ],
      });
    });

    it('checks the sum before any one payment, as the demo does', () => {
      // A transfer with no sender, for the wrong amount: the sum speaks first.
      expect(
        problemOf(
          judgePayments([{ method: 'TRANSFER', amountKobo: 50 }], settle(100)),
        ),
      ).toBe(SETTLE_EXACT_MESSAGE);
    });

    it('refuses a sender or reference longer than 120 characters', () => {
      expect(
        problemOf(
          judgePayments(
            [{ method: 'CARD', amountKobo: 100, reference: 'x'.repeat(121) }],
            settle(100),
          ),
        ),
      ).toBe('reference must be 120 characters or fewer.');
      expect(
        problemOf(
          judgePayments(
            [
              {
                method: 'TRANSFER',
                amountKobo: 100,
                sender: 'x'.repeat(121),
                reference: 'R',
              },
            ],
            settle(100),
          ),
        ),
      ).toBe('sender must be 120 characters or fewer.');
    });
  });
});
