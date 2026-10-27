import { ApiProperty } from '@nestjs/swagger';
import { AddressZone, ContactChannel } from '../../../generated/cnc-client';

/** The saved delivery address (plan §4.2). */
export class CustomerAddressResponse {
  @ApiProperty({ enum: AddressZone, nullable: true, example: 'JOS' })
  zone!: AddressZone | null;

  @ApiProperty({ example: '12 Rayfield Road' })
  street!: string;

  @ApiProperty({ example: 'Rayfield' })
  area!: string;

  @ApiProperty({ example: 'Jos' })
  town!: string;

  @ApiProperty({ example: 'Opposite the filling station' })
  landmark!: string;
}

/** The notification preferences (the account app's `Prefs`). */
export class CustomerPrefsResponse {
  @ApiProperty({ example: true })
  orderUpdates!: boolean;

  @ApiProperty({ example: true })
  bookingReminders!: boolean;

  @ApiProperty({
    example: false,
    description: 'Always false until the founder enables offers.',
  })
  offers!: boolean;

  @ApiProperty({ enum: ContactChannel, example: 'EMAIL' })
  channel!: ContactChannel;
}

/**
 * A customer's own profile: `GET /me`, and the `customer` of every session
 * response. The account app's `Profile`, with the member number added
 * (plan §4.2) and enums in `UPPER_SNAKE` (A5).
 */
export class CustomerProfileResponse {
  @ApiProperty({ example: 'cmc0customer000000000000' })
  id!: string;

  @ApiProperty({
    example: 'CNC-000001',
    description: 'The stable member number shown on the account.',
  })
  memberNo!: string;

  @ApiProperty({
    example: 'Ada Obi',
    description:
      'Empty until the customer gives a name: a new account asks for one ' +
      'straight after its first sign-in.',
  })
  name!: string;

  @ApiProperty({ example: 'ada@example.com', nullable: true, type: String })
  email!: string | null;

  @ApiProperty({
    example: '08031234567',
    nullable: true,
    type: String,
    description: '`0` plus 10 digits.',
  })
  phone!: string | null;

  @ApiProperty({
    type: CustomerAddressResponse,
    nullable: true,
    description: 'Null until an address is saved.',
  })
  address!: CustomerAddressResponse | null;

  @ApiProperty({ type: CustomerPrefsResponse })
  prefs!: CustomerPrefsResponse;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'A short-lived signed link to the photo, or null.',
  })
  photoUrl!: string | null;

  @ApiProperty({ example: '2026-10-22T09:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Notifications created after this are unread.',
  })
  notificationsReadAt!: string | null;
}
