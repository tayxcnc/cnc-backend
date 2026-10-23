import { ApiProperty } from '@nestjs/swagger';
import { CustomerNotificationKind } from '../../../generated/cnc-client';

/**
 * One item in the customer's in-app list: the account app's
 * `Notification` (`lib/account/api.ts`), with the server's unread flag and
 * a link into the account app.
 */
export class CustomerNotificationResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    description: 'When it happened (ISO UTC).',
    example: '2026-10-22T18:00:00.000Z',
  })
  at!: string;

  @ApiProperty({
    enum: CustomerNotificationKind,
    enumName: 'CustomerNotificationKind',
  })
  kind!: CustomerNotificationKind;

  @ApiProperty({ example: 'Table reserved' })
  title!: string;

  @ApiProperty({ example: 'Sofa setting 1, Lounge, Sat 24 Oct 2026 at 19:00.' })
  body!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A path in the CNC site without `/cnc` (`/account#reservations`), ' +
      'or null.',
    example: '/account#reservations',
  })
  link!: string | null;

  @ApiProperty({
    description: 'Created after `notificationsReadAt` (or nothing is read).',
  })
  unread!: boolean;
}

/** `GET /me/notifications`: the standard page, plus the unread count. */
export class CustomerNotificationPageResponse {
  @ApiProperty({ type: CustomerNotificationResponse, isArray: true })
  data!: CustomerNotificationResponse[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 4 })
  total!: number;

  @ApiProperty({
    description: 'How many items, on any page, are unread.',
    example: 1,
  })
  unread!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Items created after this instant are unread.',
  })
  notificationsReadAt!: string | null;
}

/** `POST /me/notifications/read`. */
export class NotificationsReadResponse {
  @ApiProperty({
    description: 'Everything created up to this instant is read.',
    example: '2026-10-22T18:00:00.000Z',
  })
  notificationsReadAt!: string;
}
