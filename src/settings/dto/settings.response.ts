import { ApiProperty } from '@nestjs/swagger';
import { PrinterWidth } from '../../../generated/cnc-client';

/**
 * The settings row as the staff app reads it (plan §4.1). Money in kobo,
 * rates in basis points, times in WAT minutes from midnight. `version`
 * goes back with the next `PATCH /staff/settings`.
 */
export class SettingsResponse {
  @ApiProperty({ example: 750 })
  vatBps!: number;

  @ApiProperty({ example: 0 })
  serviceBps!: number;

  @ApiProperty({ example: 0 })
  depositKobo!: number;

  @ApiProperty({ example: 180 })
  freeTableReminderMinutes!: number;

  @ApiProperty({ example: 500000 })
  deliveryJosKobo!: number;

  @ApiProperty({ example: 1000000 })
  deliveryOutsideKobo!: number;

  @ApiProperty({ example: 5000000 })
  approvalLimitKobo!: number;

  @ApiProperty({ example: true })
  dailyLimitOn!: boolean;

  @ApiProperty({ example: 15000000 })
  dailyLimitKobo!: number;

  @ApiProperty({ enum: PrinterWidth, enumName: 'PrinterWidth' })
  printerWidth!: PrinterWidth;

  @ApiProperty({ example: true })
  alertLowStock!: boolean;

  @ApiProperty({ example: true })
  alertApprovals!: boolean;

  @ApiProperty({ example: true })
  alertUnsettled!: boolean;

  @ApiProperty({ example: true })
  alertArrivals!: boolean;

  @ApiProperty({ example: 1380 })
  lastArrivalMinutes!: number;

  @ApiProperty({ example: 1410 })
  lastOrderSlotMinutes!: number;

  @ApiProperty({ example: 30 })
  slotStepMinutes!: number;

  @ApiProperty({ example: 60 })
  leadPickupMinutes!: number;

  @ApiProperty({ example: 90 })
  leadJosMinutes!: number;

  @ApiProperty({ example: 120 })
  leadOutsideMinutes!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ example: 4 })
  version!: number;
}

/**
 * CNC's business details (plan §4.1, D28): one source for the website,
 * receipts and the entrance. This is the public read (`GET /business`,
 * C6-4); the staff read adds the row's `updatedAt` and `version`.
 */
export class PublicBusinessResponse {
  @ApiProperty({ example: 'Chef Noro Culinary' })
  name!: string;

  @ApiProperty({
    description: 'One line, with no country; the site appends ", Nigeria".',
    example: '7A Hospital Place, opposite Water Board, Jos, Plateau State',
  })
  addressLine!: string;

  @ApiProperty({
    description: 'The website’s multi-line form.',
    type: String,
    isArray: true,
    example: ['7A Hospital Place,', 'opposite Water Board, Jos'],
  })
  addressLines!: string[];

  @ApiProperty({
    description: 'Digits only; each screen formats it.',
    example: '09113500003',
  })
  phone!: string;

  @ApiProperty({
    description: 'May be blank.',
    example: 'chefnoroculinarycnc@gmail.com',
  })
  email!: string;

  @ApiProperty({ example: 'RC 765598' })
  registration!: string;

  @ApiProperty({ type: Number, nullable: true, example: 9.897137833050548 })
  mapLat!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 8.889460545696355 })
  mapLng!: number | null;

  @ApiProperty({
    description: 'Network name to an https link; empty until supplied.',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { instagram: 'https://www.instagram.com/chefnoroculinary' },
  })
  socialLinks!: Record<string, string>;
}

/**
 * The business details as the staff app reads and saves them: the public
 * details with the row's `updatedAt` and the `version` the next
 * `PATCH /staff/business` names.
 */
export class BusinessResponse extends PublicBusinessResponse {
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ example: 2 })
  version!: number;
}
