import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ValidateIf } from 'class-validator';
import { PaymentMethod } from '../../../generated/cnc-client';
import { AdminReason } from '../../common/admin-reason';
import { Checked, wholeNumber } from '../../common/checked';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { OptionalText } from '../../common/optional-text';
import {
  DEPOSIT_INVALID_MESSAGE,
  DISCOUNT_INVALID_MESSAGE,
  MAX_PAYMENTS_PER_REQUEST,
  PAYMENT_MISSING_MESSAGE,
  PAYMENT_TEXT_MAX_LENGTH,
  TOO_MANY_PAYMENTS_MESSAGE,
} from '../order-messages';
import type { TillPaymentInput } from '../payment-rules';

/** Longest id accepted where a cuid is expected. */
const ID_MAX_LENGTH = 64;

/**
 * One payment as the till sends it. Documentation only: the list is checked
 * as a whole by `paymentList` and judged by `judgePayments`
 * (`payment-rules.ts`), which answers the demo's sentences in the demo's
 * order (the sum before each payment), as no nested validator could.
 */
export class TillPaymentRequest {
  @ApiProperty({
    enum: [PaymentMethod.CASH, PaymentMethod.CARD, PaymentMethod.TRANSFER],
    enumName: 'TillPaymentMethod',
  })
  method!: PaymentMethod;

  @ApiProperty({
    description: 'A whole number of kobo above zero.',
    example: 500000,
  })
  amountKobo!: number;

  @ApiPropertyOptional({
    description: 'The sender’s name; required for a transfer.',
    maxLength: PAYMENT_TEXT_MAX_LENGTH,
  })
  sender?: string;

  @ApiPropertyOptional({
    description:
      'The transfer’s reference (required for a transfer), or a card slip’s.',
    maxLength: PAYMENT_TEXT_MAX_LENGTH,
  })
  reference?: string;
}

/**
 * The `payments` field: a list of objects, at most
 * {@link MAX_PAYMENTS_PER_REQUEST} of them. Anything else is the demo's
 * "Payment information is missing.". What each payment holds is the
 * service's to judge, in the demo's order.
 */
function paymentList(value: unknown): string | null {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    )
  ) {
    return PAYMENT_MISSING_MESSAGE;
  }

  return value.length > MAX_PAYMENTS_PER_REQUEST
    ? TOO_MANY_PAYMENTS_MESSAGE
    : null;
}

/** Body of `POST /staff/orders/:id/payment`: `order.payment`. */
export class ProceedToPaymentRequest extends VersionedWriteDto {}

/** Body of `POST /staff/orders/:id/part-payments`: `order.partPay`. */
export class PartPaymentRequest extends VersionedWriteDto {
  @ApiProperty({
    type: [TillPaymentRequest],
    description:
      'One or more payments (a split is several), together above zero and ' +
      'less than the balance.',
  })
  @Checked(paymentList)
  payments!: TillPaymentInput[];
}

/** Body of `POST /staff/orders/:id/settle`: `order.settle`. */
export class SettleOrderRequest extends VersionedWriteDto {
  @ApiProperty({
    type: [TillPaymentRequest],
    description:
      'The payments that settle the bill (a split is several). Together ' +
      'they must equal the balance exactly: the total less part payments ' +
      'and any deposit credit. Empty only when nothing is left to pay.',
  })
  @Checked(paymentList)
  payments!: TillPaymentInput[];

  @ApiPropertyOptional({
    description:
      'Deposit credit to take from a checked-in booking at this table ' +
      '(D38: no route sets a deposit yet, so this is 0 or absent).',
    minimum: 0,
  })
  @ValidateIf(isSent)
  @Checked(wholeNumber(0, DEPOSIT_INVALID_MESSAGE))
  depositKobo?: number;

  @ApiPropertyOptional({
    description: 'Reservation.id the deposit credit comes from.',
  })
  @OptionalText('reservationId', ID_MAX_LENGTH)
  reservationId?: string;
}

/** Body of `POST /staff/orders/:id/discount`: `order.discount`. */
export class DiscountOrderRequest extends VersionedWriteDto {
  @ApiProperty({
    description:
      'The bill’s whole discount, in kobo, from 0 up to the subtotal. It ' +
      'replaces the discount the bill had.',
    minimum: 0,
    example: 200000,
  })
  @Checked(wholeNumber(0, DISCOUNT_INVALID_MESSAGE))
  amountKobo!: number;

  @AdminReason('Why the discount is given.')
  reason!: string;
}

/**
 * Body of `POST /staff/orders/:id/cancel`, `…/reopen` and `…/reverse`: a
 * manager's (or for a reversal the Owner's) correction, with its reason.
 */
export class OrderCorrectionRequest extends VersionedWriteDto {
  @AdminReason('Why the bill is being corrected; kept in the history.')
  reason!: string;
}
