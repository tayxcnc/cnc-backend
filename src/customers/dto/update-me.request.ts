import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';
import { AddressZone, ContactChannel } from '../../../generated/cnc-client';
import { Checked, requiredText } from '../../common/checked';
import {
  ADDRESS_LINE_MAX_LENGTH,
  deliveryAddressProblem,
} from '../../common/delivery-address';
import { isSent } from '../../common/is-sent';
import {
  PROFILE_ADDRESS_LINES_MESSAGE,
  phoneProblem,
  prefsProblem,
} from '../profile-rules';

/**
 * A blank name (400). The sign-in screen's sentence for its first-time name
 * step (`components/account/SignIn.tsx`), and Your Details' (`panels.tsx`).
 */
export const ADD_YOUR_NAME_MESSAGE = 'Add your name.';

/** The name field's length, as the screen's input caps it (`maxLength`). */
export const CUSTOMER_NAME_MAX_LENGTH = 80;

/** A name longer than the screen allows (400). */
export const NAME_TOO_LONG_MESSAGE = `Keep your name to ${CUSTOMER_NAME_MAX_LENGTH} characters.`;

/** The saved delivery address as `PATCH /me` takes it (documentation). */
export class DeliveryAddressBody {
  @ApiProperty({ enum: AddressZone, enumName: 'AddressZone', example: 'JOS' })
  zone!: AddressZone;

  @ApiProperty({
    example: '12 Rayfield Road',
    maxLength: ADDRESS_LINE_MAX_LENGTH,
  })
  street!: string;

  @ApiProperty({ example: 'Rayfield', maxLength: ADDRESS_LINE_MAX_LENGTH })
  area!: string;

  @ApiProperty({ example: 'Jos', maxLength: ADDRESS_LINE_MAX_LENGTH })
  town!: string;

  @ApiProperty({
    example: 'Opposite the filling station',
    maxLength: ADDRESS_LINE_MAX_LENGTH,
  })
  landmark!: string;
}

/** A preferences change as `PATCH /me` takes it (documentation). */
export class PrefsChangeBody {
  @ApiPropertyOptional({ example: true })
  orderUpdates?: boolean;

  @ApiPropertyOptional({ example: true })
  bookingReminders?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Refused as true until the founder enables offers.',
  })
  offers?: boolean;

  @ApiPropertyOptional({
    enum: ContactChannel,
    enumName: 'ContactChannel',
    example: 'EMAIL',
    description: '`SMS` is refused until an SMS provider exists (Q5, Q19).',
  })
  channel?: ContactChannel;
}

/**
 * Body of `PATCH /api/v1/me`. Each field changes only when it is sent.
 *
 * Name, phone, address and the notification preferences (plan §5.2). Email
 * and photo never travel here: each has its own routes (`/me/email/…`,
 * `/me/photo`), because one needs a code and the other is a file.
 *
 * The address and the preferences are checked whole, each with the one
 * sentence its screen shows (`@Checked`), never with nested validation,
 * whose messages carry the field's path (`address.zone …`) and so would not
 * be the screen's words (*Errors*).
 */
export class UpdateMeRequest {
  @ApiPropertyOptional({
    description: 'Full name, 1 to 80 characters after trimming.',
    example: 'Ada Obi',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf(isSent)
  @Checked(
    requiredText(
      ADD_YOUR_NAME_MESSAGE,
      CUSTOMER_NAME_MAX_LENGTH,
      NAME_TOO_LONG_MESSAGE,
    ),
  )
  name?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '0803 123 4567',
    description:
      'A Nigerian number, `0…`, `+234…` or `234…`, spaces and dashes ' +
      'ignored; stored and answered as `0` plus 10 digits. Null or blank ' +
      'removes it.',
  })
  @ValidateIf(isSent)
  @Checked(phoneProblem)
  phone?: string | null;

  @ApiPropertyOptional({
    type: DeliveryAddressBody,
    nullable: true,
    description:
      'The whole address: the zone and all four lines, the landmark ' +
      'included (D53), each trimmed and at most 120 characters. Null ' +
      'removes it.',
  })
  @ValidateIf(
    (_owner: object, value: unknown) => value !== undefined && value !== null,
  )
  @Checked((value) =>
    deliveryAddressProblem(value, PROFILE_ADDRESS_LINES_MESSAGE),
  )
  address?: DeliveryAddressBody | null;

  @ApiPropertyOptional({
    type: PrefsChangeBody,
    description: 'Only the switches sent change.',
  })
  @ValidateIf(isSent)
  @Checked(prefsProblem)
  prefs?: PrefsChangeBody;
}
