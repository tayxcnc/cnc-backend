import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Allow, IsIn, IsString, MaxLength, ValidateIf } from 'class-validator';
import { AdminReason } from '../../common/admin-reason';
import { Checked } from '../../common/checked';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { trimText } from '../../common/trim-text';
import {
  SCAN_CODE_MAX_LENGTH,
  SCAN_INVALID_MESSAGE,
  SHIFT_FILTER_MESSAGE,
} from '../attendance-messages';
import { SHIFT_FILTERS, type ShiftFilter } from '../attendance-rules';

/**
 * Body of `POST /staff/attendance/scan`: `attendance.scan`.
 *
 * `code` is the whole decoded staff ID, as the Reception camera or a USB
 * scanner reads it. It is a credential: compared and dropped, never
 * returned, logged or written to an audit row.
 */
export class ScanAttendanceRequest {
  @ApiProperty({
    description:
      'The decoded staff ID, `CNC-ID:<staff number>:<token>`. Anything ' +
      'else is refused with "This staff QR code is invalid or the account ' +
      'is inactive."',
    maxLength: SCAN_CODE_MAX_LENGTH,
  })
  @Checked((value) =>
    typeof value === 'string' && value.length <= SCAN_CODE_MAX_LENGTH
      ? null
      : SCAN_INVALID_MESSAGE,
  )
  code!: string;
}

/**
 * Body of `PATCH /staff/attendance/:id`: `attendance.correct`, a manager's
 * correction, with a reason. Times are Lagos wall clocks, as the Correct
 * Attendance form's `datetime-local` fields hold them (A11: the client
 * sends a date and a time, the server builds the instant). Both are
 * admitted here and judged in the service, in the demo's order.
 */
export class CorrectAttendanceRequest extends VersionedWriteDto {
  @ApiProperty({
    type: String,
    description: 'Time In, Lagos time: `YYYY-MM-DDTHH:mm`.',
    example: '2026-10-02T07:30',
  })
  @Allow()
  timeIn!: unknown;

  @ApiPropertyOptional({
    type: String,
    description:
      'Time Out, Lagos time: `YYYY-MM-DDTHH:mm`. Left out, or empty, for a ' +
      'shift still open.',
    example: '2026-10-02T16:00',
  })
  @Allow()
  timeOut?: unknown;

  @AdminReason('Why the times are corrected.')
  reason!: string;
}

/** The period of an attendance read: a month, or a range of dates. */
export class AttendanceQuery extends PaginationQuery {
  @ApiPropertyOptional({
    description:
      '`YYYY-MM`. This month in Lagos when neither this nor a range is sent.',
    example: '2026-10',
  })
  @Allow()
  month?: string;

  @ApiPropertyOptional({
    description:
      'The first business date, `YYYY-MM-DD`; with `to`, instead of a month.',
  })
  @Allow()
  from?: string;

  @ApiPropertyOptional({ description: 'The last business date, `YYYY-MM-DD`.' })
  @Allow()
  to?: string;

  @ApiPropertyOptional({
    enum: SHIFT_FILTERS,
    enumName: 'ShiftFilter',
    description:
      'ALL (the default), COMPLETED (checked out) or OPEN (still present).',
  })
  @ValidateIf(isSent)
  @IsIn(SHIFT_FILTERS, { message: SHIFT_FILTER_MESSAGE })
  filter?: ShiftFilter;
}

/** `GET /staff/attendance/:staffId/export`: the Attendance review's period. */
export class AttendanceExportQuery {
  @ApiProperty({ description: 'The first business date, `YYYY-MM-DD`.' })
  @Allow()
  from!: string;

  @ApiProperty({ description: 'The last business date, `YYYY-MM-DD`.' })
  @Allow()
  to!: string;
}

/** `GET /staff/attendance/people`. */
export class AttendancePeopleQuery extends PaginationQuery {
  @ApiPropertyOptional({
    description: 'Part of a name, staff number or email, any case.',
  })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: 'q must be text.' })
  @MaxLength(120, { message: 'q must be 120 characters or fewer.' })
  q?: string;
}
