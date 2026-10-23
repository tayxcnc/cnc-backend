import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';
import {
  ReservationSource,
  ReservationStatus,
} from '../../../generated/cnc-client';
import {
  Checked,
  calendarDate,
  requiredText,
  wholeNumber,
} from '../../common/checked';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { EMAIL_PATTERN } from '../../common/email-pattern';
import { isSent } from '../../common/is-sent';
import { normaliseEmail } from '../../common/normalise-email';
import { OptionalText } from '../../common/optional-text';
import { trimText } from '../../common/trim-text';
import { customerPhone } from '../../customers/profile-rules';
import {
  ARRIVAL_TIME_MESSAGE,
  CAPACITY_MESSAGE,
  GUEST_EMAIL_MAX_LENGTH,
  GUEST_NAME_MAX_LENGTH,
  RECEPTION_NOTE_MAX_LENGTH,
  RESERVATION_DATE_MESSAGE,
  WEB_GUEST_EMAIL_MESSAGE,
  WEB_GUEST_NAME_MESSAGE,
  WEB_GUEST_PHONE_MESSAGE,
} from '../reception-messages';
import { CLOCK } from '../reservation-rules';

const BookingDate = () => Checked(calendarDate(RESERVATION_DATE_MESSAGE));

const ArrivalTime = () =>
  Checked((value) =>
    typeof value === 'string' && CLOCK.test(value)
      ? null
      : ARRIVAL_TIME_MESSAGE,
  );

const Party = () => Checked(wholeNumber(1, CAPACITY_MESSAGE));

/** A room slug or a table code: short text, else the capacity sentence. */
const PlaceText = () =>
  applyDecorators(
    Transform(({ value }) => trimText(value)),
    Checked(requiredText(CAPACITY_MESSAGE, 64, CAPACITY_MESSAGE)),
  );

/**
 * Body of `POST /reservations` (plan §5.1, C6-5): the website's and the
 * app's booking. The table is named as the public floor plan names it, by
 * its room and code (`GET /venues`), never by a row id. The guest's
 * details are checked in the website form's order with its sentences: a
 * name, a Nigerian phone (stored as `0` plus 10 digits), an email for the
 * confirmation.
 */
export class WebReservationRequest {
  @ApiProperty({ example: 'lounge', description: 'Venue.slug.' })
  @PlaceText()
  venue!: string;

  @ApiProperty({
    example: 'TDS1',
    description: 'The table’s code within the room (`GET /venues`).',
  })
  @PlaceText()
  table!: string;

  @ApiProperty({ example: '2026-10-24', description: 'YYYY-MM-DD.' })
  @BookingDate()
  businessDate!: string;

  @ApiProperty({
    example: '19:00',
    description:
      'The arrival time in Jos, HH:mm: one of the date’s `arrivalTimes`.',
  })
  @ArrivalTime()
  time!: string;

  @ApiProperty({ example: 2, minimum: 1 })
  @Party()
  party!: number;

  @ApiProperty({ example: 'Ada Okafor', maxLength: GUEST_NAME_MAX_LENGTH })
  @Transform(({ value }) => trimText(value))
  @Checked(
    requiredText(
      WEB_GUEST_NAME_MESSAGE,
      GUEST_NAME_MAX_LENGTH,
      `Guest name must be ${GUEST_NAME_MAX_LENGTH} characters or fewer.`,
    ),
  )
  name!: string;

  @ApiProperty({
    example: '0803 123 4567',
    description: 'A Nigerian mobile number, typed any usual way.',
  })
  @Checked((value) =>
    typeof customerPhone(value) === 'string' ? null : WEB_GUEST_PHONE_MESSAGE,
  )
  phone!: string;

  @ApiProperty({
    example: 'ada@example.com',
    description: 'The confirmation is sent to it.',
  })
  @Transform(({ value }) => normaliseEmail(value))
  @Checked((value) =>
    typeof value === 'string' &&
    value.length <= GUEST_EMAIL_MAX_LENGTH &&
    EMAIL_PATTERN.test(value)
      ? null
      : WEB_GUEST_EMAIL_MESSAGE,
  )
  email!: string;

  @ApiPropertyOptional({
    maxLength: RECEPTION_NOTE_MAX_LENGTH,
    description: '"Anything we should know?"',
  })
  @OptionalText('note', RECEPTION_NOTE_MAX_LENGTH)
  note?: string;
}

/**
 * Body of `PATCH /me/reservations/:id` (C6-6): the account app's "Change
 * Date, Time or Party Size", with the booking's `version` (A8). Only the
 * fields sent change; the table stays (the app says: cancel and book again
 * for another table).
 */
export class CustomerReservationChangeRequest extends VersionedWriteDto {
  @ApiPropertyOptional({ example: '2026-10-25' })
  @ValidateIf(isSent)
  @BookingDate()
  businessDate?: string;

  @ApiPropertyOptional({ example: '19:30' })
  @ValidateIf(isSent)
  @ArrivalTime()
  time?: string;

  @ApiPropertyOptional({ example: 3, minimum: 1 })
  @ValidateIf(isSent)
  @Party()
  party?: number;
}

/**
 * A booking as its guest sees it (`AccountReservation` in the account
 * app, with the server's status, number and version): no phone, email,
 * customer or row ids beyond the booking's own.
 */
export class CustomerReservationResponse {
  @ApiProperty({ description: 'Reservation.id: the path of a change.' })
  id!: string;

  @ApiProperty({ example: 'RSV-000001' })
  number!: string;

  @ApiProperty({ example: 'lounge' })
  venue!: string;

  @ApiProperty({ example: 'Lounge' })
  venueTitle!: string;

  @ApiProperty({ example: 'TDS1' })
  tableCode!: string;

  @ApiProperty({ example: 'Sofa setting 1' })
  tableName!: string;

  @ApiProperty({ description: 'Places at the table.', example: 4 })
  capacity!: number;

  @ApiProperty({ example: '2026-10-24' })
  businessDate!: string;

  @ApiProperty({ example: '19:00' })
  time!: string;

  @ApiProperty({ example: 1140 })
  startMinutes!: number;

  @ApiProperty({ example: 2 })
  party!: number;

  @ApiProperty({ example: 'Ada Okafor' })
  name!: string;

  @ApiProperty({
    example: '',
    description:
      'What the guest wrote in "Anything we should know?" when booking ' +
      'online; blank for a booking Reception took. Never Reception’s own note.',
  })
  note!: string;

  @ApiProperty({ enum: ReservationStatus, enumName: 'ReservationStatus' })
  status!: ReservationStatus;

  @ApiProperty({ enum: ReservationSource, enumName: 'ReservationSource' })
  source!: ReservationSource;

  @ApiProperty({
    description: 'The booking’s start in Jos, as an instant.',
    example: '2026-10-24T18:00:00.000Z',
  })
  startsAt!: string;

  @ApiProperty({
    description:
      'The last instant it may be changed or cancelled online: 24 hours ' +
      'before it starts (Q6).',
    example: '2026-10-23T18:00:00.000Z',
  })
  changeableUntil!: string;

  @ApiProperty({
    description:
      'Confirmed and at least 24 hours away now, by the server’s clock: ' +
      'whether the change and cancel buttons are on.',
  })
  changeable!: boolean;

  @ApiProperty({ example: '2026-10-22T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ type: String, nullable: true })
  cancelledAt!: string | null;

  @ApiProperty({ example: 0 })
  version!: number;
}

/** `GET /me/reservations`. */
export class CustomerReservationPageResponse {
  @ApiProperty({ type: CustomerReservationResponse, isArray: true })
  data!: CustomerReservationResponse[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 3 })
  total!: number;
}
