import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ValidateIf } from 'class-validator';
import { TableKind } from '../../../generated/cnc-client';
import { Checked, calendarDate } from '../../common/checked';
import { isSent } from '../../common/is-sent';
import {
  PUBLIC_TABLE_STATUSES,
  type PublicTableStatus,
} from '../reservation-rules';
import { RESERVATION_DATE_MESSAGE } from '../reception-messages';

/** A table as the booking page shows it. */
export class PublicTableResponse {
  @ApiProperty({
    description: 'Unique within its room; the floor plan drawing names it.',
    example: 'B1',
  })
  code!: string;

  @ApiProperty({ example: 'Booth 1' })
  name!: string;

  @ApiProperty({ enum: TableKind, enumName: 'TableKind' })
  kind!: TableKind;

  @ApiProperty({ description: 'Places at the table.', example: 4 })
  capacity!: number;
}

/** A room and its tables in use. */
export class PublicVenueResponse {
  @ApiProperty({ example: 'dining' })
  slug!: string;

  @ApiProperty({ example: 'Dining' })
  title!: string;

  @ApiProperty({
    description:
      'From this many guests the booking goes to the team as a group ' +
      'enquiry: 4 in Dining, 5 in the Lounge.',
    example: 4,
  })
  bigParty!: number;

  @ApiProperty({ type: PublicTableResponse, isArray: true })
  tables!: PublicTableResponse[];
}

/** `GET /venues`. */
export class PublicVenuesResponse {
  @ApiProperty({ type: PublicVenueResponse, isArray: true })
  venues!: PublicVenueResponse[];
}

/** `GET /venues/:venue/availability?date=`. */
export class AvailabilityQuery {
  @ApiPropertyOptional({
    example: '2026-10-22',
    description:
      'The date to show (YYYY-MM-DD), today or later; today in Jos when ' +
      'absent.',
  })
  @ValidateIf(isSent)
  @Checked(calendarDate(RESERVATION_DATE_MESSAGE))
  date?: string;
}

/** One table's state on the date. */
export class TableAvailabilityResponse {
  @ApiProperty({ example: 'B1' })
  code!: string;

  @ApiProperty({
    enum: PUBLIC_TABLE_STATUSES,
    enumName: 'PublicTableStatus',
    description:
      '`RESERVED`: a booking holds it that date; `OCCUPIED`: guests are ' +
      'seated now (today only); `BLOCKED`: staff have locked it; otherwise ' +
      '`AVAILABLE`.',
  })
  status!: PublicTableStatus;
}

/** The booking page's floor plan for a date. */
export class VenueAvailabilityResponse {
  @ApiProperty({ example: 'dining' })
  venue!: string;

  @ApiProperty({ example: '2026-10-22' })
  date!: string;

  @ApiProperty({
    type: String,
    isArray: true,
    description:
      'The arrival times a booking may name that date, `HH:mm`; today’s ' +
      'passed times are left out, and a closed day has none.',
    example: ['19:00', '19:30'],
  })
  arrivalTimes!: string[];

  @ApiProperty({ type: TableAvailabilityResponse, isArray: true })
  tables!: TableAvailabilityResponse[];
}
