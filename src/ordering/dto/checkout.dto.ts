import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';
import {
  AddressZone,
  CheckoutStatus,
  CheckoutTiming,
  Fulfilment,
} from '../../../generated/cnc-client';
import { Checked, calendarDate, requiredText } from '../../common/checked';
import {
  DELIVERY_ZONE_MESSAGE,
  deliveryAddressProblem,
  isAddressZone,
} from '../../common/delivery-address';
import { EMAIL_PATTERN } from '../../common/email-pattern';
import { isSent } from '../../common/is-sent';
import { normaliseEmail } from '../../common/normalise-email';
import { OptionalText } from '../../common/optional-text';
import { trimText } from '../../common/trim-text';
import { customerPhone, PHONE_MESSAGE } from '../../customers/profile-rules';
import { CLOCK } from '../../reception/reservation-rules';
import { type CartLineInput, cartLinesProblem } from '../cart-pricing';
import {
  AREA_MESSAGE,
  CHECKOUT_EMAIL_INVALID_MESSAGE,
  CHECKOUT_EMAIL_MISSING_MESSAGE,
  CHECKOUT_NAME_MESSAGE,
  CHECKOUT_TIME_MESSAGE,
  CHECKOUT_TIMING_MESSAGE,
  SAVE_DETAILS_MESSAGE,
  STREET_MESSAGE,
  TOWN_MESSAGE,
} from '../checkout-messages';
import { FULFILMENT_MESSAGE } from './ordering.dto';

/** The longest name and email a checkout keeps. */
export const CHECKOUT_NAME_MAX_LENGTH = 80;
export const CHECKOUT_EMAIL_MAX_LENGTH = 254;
/** "Note for the kitchen or rider". */
export const CHECKOUT_NOTE_MAX_LENGTH = 500;

const isFulfilment = (value: unknown) =>
  (Object.values(Fulfilment) as unknown[]).includes(value);

const isDelivery = (owner: { fulfilment?: unknown }) =>
  owner.fulfilment === Fulfilment.DELIVERY;

const isScheduled = (owner: { timing?: unknown }) =>
  owner.timing === CheckoutTiming.SCHEDULED;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The checkout address's one sentence, in the website form's order with
 * its words: the zone, the street, the area, the town, then the landmark
 * and the length rule (`deliveryAddressProblem`, the profile's module).
 */
export function checkoutAddressProblem(value: unknown): string | null {
  if (!isRecord(value) || !isAddressZone(value.zone)) {
    return DELIVERY_ZONE_MESSAGE;
  }

  const blank = (key: string) =>
    typeof value[key] !== 'string' || value[key].trim() === '';

  if (blank('street')) return STREET_MESSAGE;
  if (blank('area')) return AREA_MESSAGE;
  if (blank('town')) return TOWN_MESSAGE;

  return deliveryAddressProblem(value, TOWN_MESSAGE);
}

/** The email field's one sentence: the website's two. */
function checkoutEmailProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') {
    return CHECKOUT_EMAIL_MISSING_MESSAGE;
  }

  return value.length <= CHECKOUT_EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(value)
    ? null
    : CHECKOUT_EMAIL_INVALID_MESSAGE;
}

/** One cart line: a dish by its menu slug, its choice, how many. */
export class CartLineRequest {
  @ApiProperty({ example: 'jollof-rice', description: 'MenuItem.slug.' })
  dishId!: string;

  @ApiPropertyOptional({
    example: 'Chicken',
    description: 'One of the dish’s options; omitted for a dish without one.',
  })
  option?: string;

  @ApiProperty({ example: 2, minimum: 1, maximum: 999 })
  qty!: number;
}

/** An address, the profile's and the checkout's one shape. */
export class CheckoutAddressRequest {
  @ApiProperty({ enum: AddressZone, enumName: 'AddressZone' })
  zone!: AddressZone;

  @ApiProperty({ example: '12 Rayfield Road' })
  street!: string;

  @ApiProperty({ example: 'Rayfield' })
  area!: string;

  @ApiProperty({ example: 'Jos' })
  town!: string;

  @ApiProperty({ example: 'Opposite the filling station' })
  landmark!: string;
}

/** Body of `POST /ordering/quote`: a cart and how it is received. */
export class QuoteRequest {
  @ApiProperty({ type: CartLineRequest, isArray: true })
  @Checked(cartLinesProblem)
  lines!: CartLineInput[];

  @ApiProperty({ enum: Fulfilment, enumName: 'Fulfilment' })
  @Checked((value) => (isFulfilment(value) ? null : FULFILMENT_MESSAGE))
  fulfilment!: Fulfilment;

  @ApiPropertyOptional({
    enum: AddressZone,
    enumName: 'AddressZone',
    description: 'Required for `DELIVERY`; ignored for `PICKUP`.',
  })
  @ValidateIf(isDelivery)
  @Checked((value) => (isAddressZone(value) ? null : DELIVERY_ZONE_MESSAGE))
  zone?: AddressZone;
}

/**
 * Body of `POST /checkouts` (plan §5.1, §7.4; C7-1): the cart, how and
 * when it is received, and who it is for. Each field answers one sentence,
 * the website form's where it has one.
 */
export class CheckoutRequest {
  @ApiProperty({ type: CartLineRequest, isArray: true })
  @Checked(cartLinesProblem)
  lines!: CartLineInput[];

  @ApiProperty({ enum: Fulfilment, enumName: 'Fulfilment' })
  @Checked((value) => (isFulfilment(value) ? null : FULFILMENT_MESSAGE))
  fulfilment!: Fulfilment;

  @ApiPropertyOptional({
    type: CheckoutAddressRequest,
    description:
      'Required for `DELIVERY` (the zone prices the fee); ignored for ' +
      '`PICKUP`. The landmark is required (D53).',
  })
  @ValidateIf(isDelivery)
  @Checked(checkoutAddressProblem)
  address?: CheckoutAddressRequest;

  @ApiProperty({ enum: CheckoutTiming, enumName: 'CheckoutTiming' })
  @Checked((value) =>
    (Object.values(CheckoutTiming) as unknown[]).includes(value)
      ? null
      : CHECKOUT_TIMING_MESSAGE,
  )
  timing!: CheckoutTiming;

  @ApiPropertyOptional({
    example: '2026-10-24',
    description:
      'For `SCHEDULED`: today or tomorrow in Jos (`GET /ordering/slots`).',
  })
  @ValidateIf(isScheduled)
  @Checked(calendarDate(CHECKOUT_TIME_MESSAGE))
  date?: string;

  @ApiPropertyOptional({
    example: '19:30',
    description: 'For `SCHEDULED`: one of that day’s slots, `HH:mm`.',
  })
  @ValidateIf(isScheduled)
  @Checked((value) =>
    typeof value === 'string' && CLOCK.test(value)
      ? null
      : CHECKOUT_TIME_MESSAGE,
  )
  time?: string;

  @ApiProperty({ example: 'Ada Okafor', maxLength: CHECKOUT_NAME_MAX_LENGTH })
  @Transform(({ value }) => trimText(value))
  @Checked(
    requiredText(
      CHECKOUT_NAME_MESSAGE,
      CHECKOUT_NAME_MAX_LENGTH,
      `Keep your name to ${CHECKOUT_NAME_MAX_LENGTH} characters.`,
    ),
  )
  name!: string;

  @ApiProperty({ example: '0803 123 4567' })
  @Checked((value) =>
    typeof customerPhone(value) === 'string' ? null : PHONE_MESSAGE,
  )
  phone!: string;

  @ApiProperty({
    example: 'ada@example.com',
    description: 'The receipt is sent to it (Q31).',
  })
  @Transform(({ value }) => normaliseEmail(value))
  @Checked(checkoutEmailProblem)
  email!: string;

  @ApiPropertyOptional({ maxLength: CHECKOUT_NOTE_MAX_LENGTH })
  @OptionalText('note', CHECKOUT_NOTE_MAX_LENGTH)
  note?: string;

  @ApiPropertyOptional({
    description:
      '"Save my details": once paid, the details are linked to (or start) ' +
      'a CNC account by this email (C7-3). Never signs anyone in (A15).',
  })
  @ValidateIf(isSent)
  @Checked((value) =>
    typeof value === 'boolean' ? null : SAVE_DETAILS_MESSAGE,
  )
  saveDetails?: boolean;
}

/** A priced line as the order page shows it. */
export class PricedLineResponse {
  @ApiProperty({ example: 'jollof-rice' })
  dishId!: string;

  @ApiProperty({ example: 'Jollof Rice' })
  name!: string;

  @ApiProperty({ example: '', description: '`""` for a dish with no choice.' })
  option!: string;

  @ApiProperty({ example: 2 })
  qty!: number;

  @ApiProperty({ description: 'The price of one, in kobo.', example: 650000 })
  unitKobo!: number;
}

/** The money: subtotal + VAT + delivery (Q33). */
export class CartSumsResponse {
  @ApiProperty({ example: 1300000 })
  subtotalKobo!: number;

  @ApiProperty({ example: 97500 })
  vatKobo!: number;

  @ApiProperty({ example: 500000 })
  deliveryKobo!: number;

  @ApiProperty({ example: 1897500 })
  totalKobo!: number;
}

/** `POST /ordering/quote`: the server's prices for a cart. */
export class QuoteResponse {
  @ApiProperty({ type: PricedLineResponse, isArray: true })
  lines!: PricedLineResponse[];

  @ApiProperty({ example: 750 })
  vatBps!: number;

  @ApiProperty({ type: CartSumsResponse })
  sums!: CartSumsResponse;

  @ApiProperty({
    type: String,
    isArray: true,
    description:
      'Sentences to show beside the cart: a drink the Bar may be short of. ' +
      'Never a refusal (plan §7.4).',
  })
  warnings!: string[];
}

/** `POST /checkouts` (201): what the order page hands Paystack. */
export class CheckoutCreatedResponse extends QuoteResponse {
  @ApiProperty({ example: 'cnc-order-6f1c…' })
  reference!: string;

  @ApiProperty({ description: 'Paystack’s access code, for the inline popup.' })
  accessCode!: string;

  @ApiProperty({ description: 'Paystack’s hosted payment page.' })
  authorizationUrl!: string;

  @ApiProperty({
    description: 'When the checkout lapses if nobody pays it (UTC).',
  })
  expiresAt!: string;
}

/**
 * `GET /checkouts/:reference`: the confirmation page after Paystack sends
 * the customer back. The reference is the capability (122 random bits);
 * the phone, email, note and account are never in it.
 */
export class CheckoutStatusResponse {
  @ApiProperty({ example: 'cnc-order-6f1c…' })
  reference!: string;

  @ApiProperty({ enum: CheckoutStatus, enumName: 'CheckoutStatus' })
  status!: CheckoutStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CNCR-000124',
    description: 'The order number, once the payment made the order.',
  })
  number!: string | null;

  @ApiProperty({ example: 'Ada Okafor' })
  name!: string;

  @ApiProperty({ enum: Fulfilment, enumName: 'Fulfilment' })
  fulfilment!: Fulfilment;

  @ApiProperty({
    enum: AddressZone,
    enumName: 'AddressZone',
    nullable: true,
  })
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

  @ApiProperty({ type: CartSumsResponse })
  sums!: CartSumsResponse;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Visa ending 4242',
    description: 'Once paid by card; null otherwise.',
  })
  card!: string | null;
}
