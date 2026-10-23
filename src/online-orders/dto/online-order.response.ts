import { ApiProperty } from '@nestjs/swagger';
import {
  OnlineFulfilmentStatus,
  OnlineOrderMode,
  OnlineRefundStatus,
} from '../../../generated/cnc-client';
import { DocketResponse, OrderResponse } from '../../orders/dto/order.response';

/** What a paid web order is worth and what has been paid against it. */
export class OnlineMoneyResponse {
  @ApiProperty({ description: 'The bill: lines plus VAT (Q21: no fee).' })
  billTotalKobo!: number;
  @ApiProperty({ description: 'The delivery fee, its own line (Q21).' })
  feeKobo!: number;
  @ApiProperty({
    description:
      'What the order is worth now: the bill plus the fee; 0 once cancelled.',
  })
  totalKobo!: number;
  @ApiProperty({
    description: 'Money received less money returned, reversed excluded.',
  })
  paidKobo!: number;
  @ApiProperty({
    description:
      'Total less paid: above 0 extra money is due from the customer, ' +
      'below 0 a refund is owed. The order completes only at 0.',
  })
  balanceKobo!: number;
  @ApiProperty({
    description:
      'What a card refund may still return: card payments less card ' +
      'refunds not refused.',
  })
  cardRefundableKobo!: number;
}

/** The zone fees the order snapshotted at checkout (Q27). */
export class OnlineZoneFeesResponse {
  @ApiProperty({ example: 500000 }) deliveryJosKobo!: number;
  @ApiProperty({ example: 1000000 }) deliveryOutsideKobo!: number;
}

/** The delivery address as stored, or null for pickup. */
export class OnlineAddressResponse {
  @ApiProperty() street!: string;
  @ApiProperty() area!: string;
  @ApiProperty() town!: string;
  @ApiProperty() landmark!: string;
}

/** A change a manager made to the money of the order. */
export class OnlineAdjustmentResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'online.edit' }) action!: string;
  @ApiProperty({ description: '+ extra money due, − a refund owed.' })
  amountKobo!: number;
  @ApiProperty() reason!: string;
  @ApiProperty() staffName!: string;
  @ApiProperty({
    description: 'Open until settled; an open one blocks Completed.',
  })
  settled!: boolean;
  @ApiProperty({ type: String, nullable: true }) settledAt!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'PAY-000012' })
  settledPaymentNumber!: string | null;
  @ApiProperty() createdAt!: string;
}

/** A card refund sent through Paystack (Q26). */
export class OnlineRefundResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'PAY-000013' }) paymentNumber!: string;
  @ApiProperty({ description: 'The money returned (positive).' })
  amountKobo!: number;
  @ApiProperty({ enum: OnlineRefundStatus, enumName: 'OnlineRefundStatus' })
  status!: OnlineRefundStatus;
  @ApiProperty({ type: String, nullable: true })
  providerRefundId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Paystack’s words on a refusal, for staff.',
  })
  providerMessage!: string | null;
  @ApiProperty() staffName!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) sentAt!: string | null;
}

/** One row of the Online Orders list. */
export class OnlineOrderSummaryResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'WEB-000012' }) number!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty({ example: 'CNCR-000124' }) orderNumber!: string;
  @ApiProperty() contactName!: string;
  @ApiProperty() contactPhone!: string;
  @ApiProperty({ enum: OnlineOrderMode, enumName: 'OnlineOrderMode' })
  mode!: OnlineOrderMode;
  @ApiProperty({ description: '`""` for pickup.' }) addressText!: string;
  @ApiProperty({
    enum: OnlineFulfilmentStatus,
    enumName: 'OnlineFulfilmentStatus',
  })
  fulfilmentStatus!: OnlineFulfilmentStatus;
  @ApiProperty({ example: 'As soon as possible (about 90 minutes)' })
  timingText!: string;
  @ApiProperty({ type: String, nullable: true }) scheduledFor!: string | null;
  @ApiProperty() totalKobo!: number;
  @ApiProperty() paidKobo!: number;
  @ApiProperty() balanceKobo!: number;
  @ApiProperty({ description: 'When it was paid and placed (UTC).' })
  createdAt!: string;
  @ApiProperty() version!: number;
}

/** `GET /staff/online-orders`. */
export class OnlineOrderPageResponse {
  @ApiProperty({ type: OnlineOrderSummaryResponse, isArray: true })
  data!: OnlineOrderSummaryResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

/** `GET /staff/online-orders/:id`, and what every command answers. */
export class OnlineOrderResponse extends OnlineOrderSummaryResponse {
  @ApiProperty({ example: 'cnc-order-6f1c…' }) paystackReference!: string;
  @ApiProperty() contactEmail!: string;
  @ApiProperty({ type: OnlineAddressResponse, nullable: true })
  address!: OnlineAddressResponse | null;
  @ApiProperty({ description: 'Note for the kitchen or rider.' }) note!: string;
  @ApiProperty({ type: OnlineZoneFeesResponse })
  zoneFees!: OnlineZoneFeesResponse;
  @ApiProperty({ type: OnlineMoneyResponse }) money!: OnlineMoneyResponse;
  @ApiProperty({
    description:
      'The bill: its lines, payments (refunds negative) and latest docket.',
    type: OrderResponse,
  })
  order!: OrderResponse;
  @ApiProperty({ type: OnlineAdjustmentResponse, isArray: true })
  adjustments!: OnlineAdjustmentResponse[];
  @ApiProperty({ type: OnlineRefundResponse, isArray: true })
  refunds!: OnlineRefundResponse[];
}

/**
 * `online.edit`, `online.cancel` and `online.zone`: the order, and the
 * docket revision the change wrote for the Cashier to print, or null.
 */
export class OnlineOrderChangeResponse {
  @ApiProperty({ type: OnlineOrderResponse }) onlineOrder!: OnlineOrderResponse;
  @ApiProperty({ type: DocketResponse, nullable: true })
  docket!: DocketResponse | null;
}
