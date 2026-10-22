import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ValidateIf } from 'class-validator';
import { AddressZone, Fulfilment } from '../../../generated/cnc-client';
import { Checked } from '../../common/checked';
import {
  DELIVERY_ZONE_MESSAGE,
  isAddressZone,
} from '../../common/delivery-address';

/**
 * A fulfilment that is not `DELIVERY` or `PICKUP` (400). New: the website
 * offers two buttons, so only a hand-made request meets it.
 */
export const FULFILMENT_MESSAGE = 'Choose delivery or pickup.';

/** A delivery zone and what it costs and takes. */
export class OrderingZoneResponse {
  @ApiProperty({ enum: AddressZone, enumName: 'AddressZone', example: 'JOS' })
  zone!: AddressZone;

  @ApiProperty({ description: 'The delivery fee, in kobo.', example: 500000 })
  feeKobo!: number;

  @ApiProperty({
    description: 'Minutes from placing the order to receiving it.',
    example: 90,
  })
  leadMinutes!: number;
}

/** Pickup's timing. Pickup is free. */
export class OrderingPickupResponse {
  @ApiProperty({
    description: 'Minutes from placing the order to collecting it.',
    example: 60,
  })
  leadMinutes!: number;
}

/**
 * `GET /ordering/config`: what the order page prices and times a cart
 * with. The zone labels, hints and arrival texts stay the website's copy.
 */
export class OrderingConfigResponse {
  @ApiProperty({
    description: 'VAT on the subtotal, in basis points (750 is 7.5%).',
    example: 750,
  })
  vatBps!: number;

  @ApiProperty({ type: OrderingPickupResponse })
  pickup!: OrderingPickupResponse;

  @ApiProperty({
    type: OrderingZoneResponse,
    isArray: true,
    description: 'Within Jos first, then elsewhere in Plateau.',
  })
  zones!: OrderingZoneResponse[];

  @ApiProperty({
    description:
      'Scheduled times fall on this grid from each day’s opening ' +
      '(`GET /opening-hours`).',
    example: 30,
  })
  slotStepMinutes!: number;

  @ApiProperty({
    description: 'The last time an order can be received, `HH:mm` in Jos.',
    example: '23:30',
  })
  lastOrderSlot!: string;
}

/** `GET /ordering/slots?fulfilment=&zone=`. */
export class OrderingSlotsQuery {
  @ApiProperty({ enum: Fulfilment, enumName: 'Fulfilment' })
  @Checked((value) =>
    (Object.values(Fulfilment) as unknown[]).includes(value)
      ? null
      : FULFILMENT_MESSAGE,
  )
  fulfilment!: Fulfilment;

  @ApiPropertyOptional({
    enum: AddressZone,
    enumName: 'AddressZone',
    description: 'Required for `DELIVERY`; ignored for `PICKUP`.',
  })
  @ValidateIf(
    (owner: { fulfilment?: unknown }) =>
      owner.fulfilment === Fulfilment.DELIVERY,
  )
  @Checked((value) => (isAddressZone(value) ? null : DELIVERY_ZONE_MESSAGE))
  zone?: AddressZone;
}

/** `GET /ordering/slots`: when an order placed now can be received. */
export class OrderingSlotsResponse {
  @ApiProperty({
    description:
      'Whether "As soon as possible" is offered: CNC is open now and the ' +
      'order would arrive by the last order slot.',
  })
  asap!: boolean;

  @ApiProperty({ description: 'The lead time used, in minutes.', example: 90 })
  leadMinutes!: number;

  @ApiProperty({ description: 'Today in Jos.', example: '2026-10-22' })
  todayDate!: string;

  @ApiProperty({
    type: String,
    isArray: true,
    description: 'Today’s scheduled times, `HH:mm`; empty when none is left.',
    example: ['19:30', '20:00'],
  })
  today!: string[];

  @ApiProperty({ description: 'Tomorrow in Jos.', example: '2026-10-23' })
  tomorrowDate!: string;

  @ApiProperty({
    type: String,
    isArray: true,
    description: 'Tomorrow’s scheduled times, `HH:mm`.',
    example: ['08:00', '08:30'],
  })
  tomorrow!: string[];
}
