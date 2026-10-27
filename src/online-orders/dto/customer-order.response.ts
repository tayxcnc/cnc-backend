import { ApiProperty } from '@nestjs/swagger';
import {
  AddressZone,
  Fulfilment,
  OnlineFulfilmentStatus,
} from '../../../generated/cnc-client';
import {
  CartSumsResponse,
  PricedLineResponse,
} from '../../ordering/dto/checkout.dto';

/**
 * One of the signed-in customer's web orders (plan §5.2, card C7-6): the
 * account app's `AccountOrder` and its tracker, read from the stored
 * status. The lines and sums are the order as it now stands, a manager's
 * edits and zone change included; the money is `*Kobo`.
 */
export class CustomerOrderResponse {
  @ApiProperty({
    example: 'CNCR-000124',
    description:
      'The order number, as the confirmation page shows it and the ' +
      'tracker’s link (`/account#order/<number>`) names it.',
  })
  number!: string;

  @ApiProperty({ example: 'WEB-000042' })
  onlineNumber!: string;

  @ApiProperty({ example: '2026-10-24T11:05:00.000Z' })
  createdAt!: string;

  @ApiProperty({
    enum: OnlineFulfilmentStatus,
    enumName: 'OnlineFulfilmentStatus',
    description:
      'The stored stage, set by staff: RECEIVED, PREPARING, ON_THE_WAY ' +
      '(delivery), READY (pickup), DELIVERED, COLLECTED or CANCELLED.',
  })
  status!: OnlineFulfilmentStatus;

  @ApiProperty({ enum: Fulfilment, enumName: 'Fulfilment' })
  fulfilment!: Fulfilment;

  @ApiProperty({ enum: AddressZone, enumName: 'AddressZone', nullable: true })
  zone!: AddressZone | null;

  @ApiProperty({
    example: '12 Rayfield Road, Rayfield, Jos, Landmark: Opposite the …',
    description: 'The delivery address, or "Pickup at CNC, …".',
  })
  address!: string;

  @ApiProperty({ example: 'As soon as possible, about 90 minutes' })
  timing!: string;

  @ApiProperty({ type: String, nullable: true })
  scheduledFor!: string | null;

  @ApiProperty({ type: PricedLineResponse, isArray: true })
  lines!: PricedLineResponse[];

  @ApiProperty({
    type: CartSumsResponse,
    description:
      'Subtotal + VAT + delivery (Q33) of the order as it stands; ' +
      '`deliveryKobo` is 0 for a pickup.',
  })
  sums!: CartSumsResponse;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Visa ending 4081',
    description: 'The card that paid; null when Paystack did not say.',
  })
  card!: string | null;
}

/** `GET /me/orders`: newest first. */
export class CustomerOrderPageResponse {
  @ApiProperty({ type: CustomerOrderResponse, isArray: true })
  data!: CustomerOrderResponse[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 3 })
  total!: number;
}
