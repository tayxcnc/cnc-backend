import { paymentMismatch } from './checkout-payment-rules';
import type { VerifiedTransaction } from './paystack-client';
import {
  cardBrandName,
  cardText,
  readTransaction,
} from './paystack-transaction';

const EXPECTED = { reference: 'cnc-order-x', totalKobo: 1897500 };

const paid = (
  over: Partial<VerifiedTransaction> = {},
): VerifiedTransaction => ({
  status: 'success',
  reference: 'cnc-order-x',
  amountKobo: 1897500,
  currency: 'NGN',
  paidAt: new Date(),
  card: undefined,
  ...over,
});

describe('paymentMismatch (plan §7.4 step 3)', () => {
  it('passes verify and the event agreeing on the reference, total and NGN', () => {
    expect(paymentMismatch(EXPECTED, paid(), paid())).toBeNull();
    expect(paymentMismatch(EXPECTED, undefined, paid())).toBeNull();
  });

  it.each([
    ['a verify that is not success', paid(), paid({ status: 'failed' })],
    ['another reference', paid(), paid({ reference: 'cnc-order-y' })],
    ['a smaller verified amount', paid(), paid({ amountKobo: 1897400 })],
    ['a larger verified amount', paid(), paid({ amountKobo: 1897600 })],
    ['no verified amount', paid(), paid({ amountKobo: undefined })],
    ['another verified currency', paid(), paid({ currency: 'USD' })],
    ['an event with another amount', paid({ amountKobo: 100 }), paid()],
    ['an event with another currency', paid({ currency: 'GHS' }), paid()],
    ['an event without an amount', paid({ amountKobo: undefined }), paid()],
  ])('holds %s', (_name, event, verified) => {
    expect(paymentMismatch(EXPECTED, event, verified)).toEqual(
      expect.any(String),
    );
  });

  it('words an amount mismatch with both figures', () => {
    expect(
      paymentMismatch(EXPECTED, undefined, paid({ amountKobo: 100 })),
    ).toBe('Paystack verified ₦1.00; the checkout asked for ₦18,975.00.');
  });
});

describe('readTransaction', () => {
  it('narrows a charge, card type and last four only', () => {
    expect(
      readTransaction({
        status: 'success',
        reference: 'r',
        amount: 500,
        currency: 'NGN',
        paid_at: '2026-10-23T10:00:00.000Z',
        authorization: { card_type: 'visa ', last4: '4081', bin: '408408' },
      }),
    ).toEqual({
      status: 'success',
      reference: 'r',
      amountKobo: 500,
      currency: 'NGN',
      paidAt: new Date('2026-10-23T10:00:00.000Z'),
      card: { type: 'visa', last4: '4081' },
    });
  });

  it('leaves out what is not in the expected shape, and never throws', () => {
    expect(readTransaction('nonsense')).toBeUndefined();
    expect(readTransaction({ amount: 1 })).toBeUndefined();
    expect(
      readTransaction({
        status: 'success',
        amount: 12.5,
        currency: 3,
        authorization: { last4: '40' },
      }),
    ).toEqual({
      status: 'success',
      reference: undefined,
      amountKobo: undefined,
      currency: undefined,
      paidAt: undefined,
      card: undefined,
    });
  });
});

describe('the card as a receipt names it', () => {
  it('names the brand and its last four', () => {
    expect(cardBrandName('visa ')).toBe('Visa');
    expect(cardBrandName('mastercard DEBIT')).toBe('Mastercard');
    expect(cardBrandName('verve')).toBe('Verve');
    expect(cardBrandName('something')).toBe('Card');
    expect(cardText('Visa', '4242')).toBe('Visa ending 4242');
    expect(cardText(null, null)).toBeNull();
  });
});
