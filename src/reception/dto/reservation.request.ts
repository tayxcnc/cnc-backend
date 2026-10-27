import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, ValidateIf } from 'class-validator';
import {
  Checked,
  calendarDate,
  requiredText,
  wholeNumber,
} from '../../common/checked';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { EMAIL_PATTERN } from '../../common/email-pattern';
import { isSent } from '../../common/is-sent';
import { normaliseEmail } from '../../common/normalise-email';
import { OptionalText } from '../../common/optional-text';
import { trimText } from '../../common/trim-text';
import {
  ARRIVAL_TIME_MESSAGE,
  CAPACITY_MESSAGE,
  GUEST_EMAIL_MAX_LENGTH,
  GUEST_EMAIL_MESSAGE,
  GUEST_NAME_MAX_LENGTH,
  GUEST_NAME_PHONE_MESSAGE,
  GUEST_PHONE_MAX_LENGTH,
  RECEPTION_NOTE_MAX_LENGTH,
  RESERVATION_DATE_MESSAGE,
} from '../reception-messages';
import { CLOCK } from '../reservation-rules';

/**
 * Each field answers one sentence at most (`Checked`, *Errors*). Where the
 * demo answers two fields with one sentence (the guest's name and phone;
 * the table and the party), the second field is checked only once the
 * first is good, so the staff app never shows the sentence twice.
 */

const nameIsGood = (value: unknown) =>
  typeof value === 'string' &&
  value.trim() !== '' &&
  value.length <= GUEST_NAME_MAX_LENGTH;

const tableIsGood = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' && value.length <= 64;

const GuestName = () =>
  applyDecorators(
    Transform(({ value }) => trimText(value)),
    Checked(
      requiredText(
        GUEST_NAME_PHONE_MESSAGE,
        GUEST_NAME_MAX_LENGTH,
        `Guest name must be ${GUEST_NAME_MAX_LENGTH} characters or fewer.`,
      ),
    ),
  );

const GuestPhone = () =>
  applyDecorators(
    Transform(({ value }) => trimText(value)),
    Checked(
      requiredText(
        GUEST_NAME_PHONE_MESSAGE,
        GUEST_PHONE_MAX_LENGTH,
        `Phone number must be ${GUEST_PHONE_MAX_LENGTH} characters or fewer.`,
      ),
    ),
  );

const GuestEmail = () =>
  applyDecorators(
    Transform(({ value }) => normaliseEmail(value)),
    Checked((value) =>
      typeof value === 'string' &&
      value.length <= GUEST_EMAIL_MAX_LENGTH &&
      EMAIL_PATTERN.test(value)
        ? null
        : GUEST_EMAIL_MESSAGE,
    ),
  );

const TableId = () =>
  applyDecorators(
    Transform(({ value }) => trimText(value)),
    Checked(requiredText(CAPACITY_MESSAGE, 64, CAPACITY_MESSAGE)),
  );

const Party = () => Checked(wholeNumber(1, CAPACITY_MESSAGE));

const BookingDate = () => Checked(calendarDate(RESERVATION_DATE_MESSAGE));

const ArrivalTime = () =>
  Checked((value) =>
    typeof value === 'string' && CLOCK.test(value)
      ? null
      : ARRIVAL_TIME_MESSAGE,
  );

/** Body of `POST /staff/reservations`: `reservation.create` from Reception. */
export class CreateReservationRequest {
  @ApiProperty({ example: 'Ada Okafor', maxLength: GUEST_NAME_MAX_LENGTH })
  @GuestName()
  name!: string;

  @ApiProperty({
    example: '0803 123 4567',
    maxLength: GUEST_PHONE_MAX_LENGTH,
    description:
      'A Nigerian mobile number is stored as 0 plus 10 digits however it ' +
      'is typed; any other number as typed.',
  })
  @ValidateIf((request: CreateReservationRequest) => nameIsGood(request.name))
  @GuestPhone()
  phone!: string;

  @ApiProperty({
    example: 'ada@example.com',
    description: 'Required: the confirmation is sent to it.',
  })
  @GuestEmail()
  email!: string;

  @ApiProperty({ description: 'DiningTable.id.' })
  @TableId()
  tableId!: string;

  @ApiProperty({ example: 2, minimum: 1 })
  @ValidateIf((request: CreateReservationRequest) =>
    tableIsGood(request.tableId),
  )
  @Party()
  party!: number;

  @ApiProperty({
    example: '2026-10-22',
    description: 'The booking date (YYYY-MM-DD).',
  })
  @BookingDate()
  businessDate!: string;

  @ApiProperty({
    example: '19:00',
    description: 'The arrival time in Jos, HH:mm.',
  })
  @ArrivalTime()
  time!: string;

  @ApiPropertyOptional({
    maxLength: RECEPTION_NOTE_MAX_LENGTH,
    description: 'A note Reception sees with the booking.',
  })
  @OptionalText('note', RECEPTION_NOTE_MAX_LENGTH)
  note?: string;
}

/**
 * Body of `PATCH /staff/reservations/:id`: `reservation.change`
 * (Reception's "Change booking", new; plan §16). Only the fields sent
 * change; `null` is refused.
 */
export class ChangeReservationRequest extends VersionedWriteDto {
  @ApiPropertyOptional({ maxLength: GUEST_NAME_MAX_LENGTH })
  @ValidateIf(isSent)
  @GuestName()
  name?: string;

  @ApiPropertyOptional({ maxLength: GUEST_PHONE_MAX_LENGTH })
  @ValidateIf(
    (request: ChangeReservationRequest, value: unknown) =>
      value !== undefined &&
      (request.name === undefined || nameIsGood(request.name)),
  )
  @GuestPhone()
  phone?: string;

  @ApiPropertyOptional()
  @ValidateIf(isSent)
  @GuestEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'DiningTable.id: move the booking.' })
  @ValidateIf(isSent)
  @TableId()
  tableId?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @ValidateIf(
    (request: ChangeReservationRequest, value: unknown) =>
      value !== undefined &&
      (request.tableId === undefined || tableIsGood(request.tableId)),
  )
  @Party()
  party?: number;

  @ApiPropertyOptional({ example: '2026-10-22' })
  @ValidateIf(isSent)
  @BookingDate()
  businessDate?: string;

  @ApiPropertyOptional({ example: '19:30' })
  @ValidateIf(isSent)
  @ArrivalTime()
  time?: string;

  @ApiPropertyOptional({ maxLength: RECEPTION_NOTE_MAX_LENGTH })
  @OptionalText('note', RECEPTION_NOTE_MAX_LENGTH)
  note?: string;
}

/** Body of check-in, cancel and no show: the booking's `version` (A8). */
export class ReservationCommandRequest extends VersionedWriteDto {}

/** `GET /staff/reservations`: one date's bookings, or every date's (History). */
export class ReservationListQuery extends PaginationQuery {
  @ApiPropertyOptional({
    example: '2026-10-22',
    description: 'The booking date (YYYY-MM-DD); today in Jos when absent.',
  })
  @ValidateIf(isSent)
  @BookingDate()
  date?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'true lists every date (Reception’s History); `date` is then ignored.',
  })
  @ValidateIf(isSent)
  @IsIn(['true', 'false'], { message: 'all must be true or false.' })
  all?: 'true' | 'false';

  @ApiPropertyOptional({
    description: 'Search by guest name, booking number or phone.',
  })
  @OptionalText('q', 100)
  q?: string;
}
