import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, ValidateIf } from 'class-validator';
import { TableSessionStatus } from '../../../generated/cnc-client';
import {
  Checked,
  calendarDate,
  requiredText,
  wholeNumber,
} from '../../common/checked';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { OptionalText } from '../../common/optional-text';
import {
  NO_ALLOCATION_MESSAGE,
  RECEPTION_NOTE_MAX_LENGTH,
  RESERVATION_DATE_MESSAGE,
  SEAT_GUESTS_MESSAGE,
  TABLE_STATUS_MESSAGE,
} from '../reception-messages';

/**
 * Body of `POST /staff/tables/:id/allocate`: `table.allocate`, seating
 * walk-in guests (Occupied: a guest and a party) or locking the table
 * (Locked: a reason). Which fields a status needs, and the party against
 * the table's places, are the service's checks, in the demo's order.
 */
export class AllocateTableRequest {
  @ApiProperty({
    enum: [TableSessionStatus.OCCUPIED, TableSessionStatus.LOCKED],
    enumName: 'TableSessionStatus',
  })
  @IsIn([TableSessionStatus.OCCUPIED, TableSessionStatus.LOCKED], {
    message: TABLE_STATUS_MESSAGE,
  })
  status!: TableSessionStatus;

  @ApiPropertyOptional({
    maxLength: RECEPTION_NOTE_MAX_LENGTH,
    description: 'Occupied: the guest name or a description.',
  })
  @OptionalText('guest', RECEPTION_NOTE_MAX_LENGTH)
  guest?: string;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Occupied: the party, 1 to the table’s places.',
  })
  @ValidateIf(isSent)
  @Checked(wholeNumber(0, SEAT_GUESTS_MESSAGE))
  party?: number;

  @ApiPropertyOptional({
    maxLength: RECEPTION_NOTE_MAX_LENGTH,
    description: 'Locked: the reason.',
  })
  @OptionalText('note', RECEPTION_NOTE_MAX_LENGTH)
  note?: string;
}

/**
 * Body of `POST /staff/tables/:id/release`: the open seating the floor
 * read showed (`session.id`) and its `version` (A8). Naming the seating,
 * not only the table, means a release pressed on a stale screen cannot
 * free guests seated after it: every seating starts at version 0, so a
 * version alone would match the next one.
 */
export class ReleaseTableRequest extends VersionedWriteDto {
  @ApiProperty({ description: 'TableSession.id: the seating to end.' })
  @Checked(requiredText(NO_ALLOCATION_MESSAGE, 64, NO_ALLOCATION_MESSAGE))
  sessionId!: string;
}

/** `GET /staff/floor?venue&date`. */
export class FloorQuery {
  @ApiPropertyOptional({
    example: 'dining',
    description: 'Venue.slug: one room; every room when absent.',
  })
  @OptionalText('venue', 40)
  venue?: string;

  @ApiPropertyOptional({
    example: '2026-10-22',
    description:
      'The date whose bookings are shown (YYYY-MM-DD); today in Jos when ' +
      'absent. Point of Sale roles read today only.',
  })
  @ValidateIf(isSent)
  @Checked(calendarDate(RESERVATION_DATE_MESSAGE))
  date?: string;
}
