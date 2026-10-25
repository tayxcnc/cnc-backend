import { PaymentMethod } from '../../generated/cnc-client';
import { PaymentKind } from './dto/reports.response';
import { paymentKind } from './reports.service';

describe('paymentKind (the Payments Received Kind column)', () => {
  const kind = (method: PaymentMethod, amountKobo: number, part = false) =>
    paymentKind({ method, amountKobo, part });

  it('keeps the demo’s three kinds for money taken', () => {
    expect(kind(PaymentMethod.CASH, 100_000, true)).toBe(
      PaymentKind.PART_PAYMENT,
    );
    expect(kind(PaymentMethod.ONLINE, 1_467_500)).toBe(
      PaymentKind.ONLINE_CHECKOUT,
    );
    expect(kind(PaymentMethod.CARD, 645_000)).toBe(PaymentKind.FINAL_PAYMENT);
    expect(kind(PaymentMethod.TRANSFER, 50_000)).toBe(
      PaymentKind.FINAL_PAYMENT,
    );
  });

  it('calls money paid back a Refund, whatever its method', () => {
    expect(kind(PaymentMethod.ONLINE, -150_000)).toBe(PaymentKind.REFUND);
    expect(kind(PaymentMethod.CASH, -20_000)).toBe(PaymentKind.REFUND);
    expect(kind(PaymentMethod.TRANSFER, -20_000, true)).toBe(
      PaymentKind.REFUND,
    );
  });
});
