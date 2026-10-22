import { ApiProperty } from '@nestjs/swagger';
import { AttendanceSource, StaffRole } from '../../../generated/cnc-client';
import {
  ATTENDANCE_EXPORT_COLUMNS,
  ATTENDANCE_EXPORT_TITLE,
} from '../attendance-messages';

/** What a scan did. */
export const SCAN_ACTIONS = [
  'CHECKED_IN',
  'CHECKED_OUT',
  'REPEAT_IGNORED',
] as const;

export type ScanAction = (typeof SCAN_ACTIONS)[number];

/** A shift's state: still present, or checked out. */
export const SHIFT_STATES = ['PRESENT', 'COMPLETED'] as const;

export type ShiftState = (typeof SHIFT_STATES)[number];

/**
 * `POST /staff/attendance/scan`: what Reception's scanner shows. The code
 * that was scanned is in no field.
 */
export class ScanAttendanceResponse {
  @ApiProperty({
    enum: SCAN_ACTIONS,
    enumName: 'AttendanceScanAction',
    description:
      'CHECKED_IN or CHECKED_OUT; REPEAT_IGNORED for a second scan within ' +
      'a minute of the last, which records nothing.',
  })
  action!: ScanAction;

  @ApiProperty({ description: 'True for REPEAT_IGNORED.' })
  duplicate!: boolean;

  @ApiProperty() staffId!: string;
  @ApiProperty({ example: 'CNC-S004' }) staffNo!: string;
  @ApiProperty({ example: 'Daniel Musa' }) name!: string;
  @ApiProperty({ enum: StaffRole, enumName: 'StaffRole' }) role!: StaffRole;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A short-lived signed link to the person’s photograph.',
  })
  photoUrl!: string | null;

  @ApiProperty({
    description:
      'When the scan was recorded (ISO 8601, UTC); for a repeat, the scan ' +
      'it repeated.',
  })
  at!: string;
}

/** One correction of a shift: the times it replaced, who, and why. */
export class AttendanceCorrectionResponse {
  @ApiProperty({ description: 'When (ISO 8601, UTC).' }) at!: string;
  @ApiProperty() staffId!: string;
  @ApiProperty({ description: 'Who corrected it.' }) staffName!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ description: 'Time In before the correction.' })
  beforeIn!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Time Out before the correction; null if it was open.',
  })
  beforeOut!: string | null;
}

/** A shift as the attendance reads answer it. */
export class AttendanceRecordResponse {
  @ApiProperty() id!: string;
  @ApiProperty() staffId!: string;
  @ApiProperty({
    description:
      'The Lagos date of arrival (YYYY-MM-DD). A shift past midnight ' +
      'belongs to the day it began.',
  })
  businessDate!: string;
  @ApiProperty({ description: 'ISO 8601, UTC.' }) timeIn!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'ISO 8601, UTC; null while still present.',
  })
  timeOut!: string | null;
  @ApiProperty({ enum: AttendanceSource, enumName: 'AttendanceSource' })
  source!: AttendanceSource;
  @ApiProperty({ enum: SHIFT_STATES, enumName: 'ShiftState' })
  state!: ShiftState;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Completed hours, two decimal places; null while open.',
    example: 8.5,
  })
  hours!: number | null;
  @ApiProperty({ type: AttendanceCorrectionResponse, isArray: true })
  corrections!: AttendanceCorrectionResponse[];
  @ApiProperty({ example: 0 }) version!: number;
}

/** The person an attendance read is about. */
export class AttendancePersonResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'CNC-S004' }) staffNo!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: StaffRole, enumName: 'StaffRole' }) role!: StaffRole;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: String, nullable: true }) photoUrl!: string | null;
}

/** The figures over the shifts read (the demo's `attendanceSummary`). */
export class AttendanceSummaryResponse {
  @ApiProperty({ description: 'Days with an arrival, each counted once.' })
  days!: number;
  @ApiProperty() shifts!: number;
  @ApiProperty() completed!: number;
  @ApiProperty() open!: number;
  @ApiProperty({
    description: 'Completed hours, two decimal places. Open shifts add none.',
  })
  hours!: number;
  @ApiProperty() corrections!: number;
}

/** `GET /staff/attendance/:staffId` and `GET /staff/me/attendance`. */
export class AttendancePageResponse {
  @ApiProperty({ type: AttendancePersonResponse })
  staff!: AttendancePersonResponse;
  @ApiProperty({ example: '2026-10-01' }) from!: string;
  @ApiProperty({ example: '2026-10-31' }) to!: string;
  @ApiProperty({ type: AttendanceSummaryResponse })
  summary!: AttendanceSummaryResponse;
  @ApiProperty({
    type: AttendanceRecordResponse,
    isArray: true,
    description: 'Oldest arrival first.',
  })
  data!: AttendanceRecordResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

/** A member of staff in the Attendance directory. */
export class AttendanceDirectoryEntryResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'CNC-S004' }) staffNo!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: StaffRole, enumName: 'StaffRole' }) role!: StaffRole;
  @ApiProperty() email!: string;
  @ApiProperty({ type: String, nullable: true }) photoUrl!: string | null;
}

export class AttendanceDirectoryResponse {
  @ApiProperty({ type: AttendanceDirectoryEntryResponse, isArray: true })
  data!: AttendanceDirectoryEntryResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

/**
 * `GET /staff/attendance/:staffId/export`: the monthly Attendance review
 * (Q12's default title), as rows the staff app turns into its CSV, PDF and
 * print preview. Every shift of the period, oldest first, in Lagos time;
 * no pay is calculated and no absence assumed.
 */
export class AttendanceExportResponse {
  @ApiProperty({ example: ATTENDANCE_EXPORT_TITLE }) title!: string;
  @ApiProperty({ example: 'Daniel Musa | CNC-S004 | 2026-10-01 to 2026-10-31' })
  subtitle!: string;
  @ApiProperty({
    example: 'CNC-Attendance-review-CNC-S004-2026-10-01-to-2026-10-31',
  })
  fileName!: string;
  @ApiProperty({ type: AttendancePersonResponse })
  staff!: AttendancePersonResponse;
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ type: AttendanceSummaryResponse })
  summary!: AttendanceSummaryResponse;
  @ApiProperty({
    type: String,
    isArray: true,
    example: [...ATTENDANCE_EXPORT_COLUMNS],
  })
  columns!: string[];
  @ApiProperty({
    description:
      'One row per shift, in the columns’ order: date, staff number, name, ' +
      'time in, time out (empty while open), hours (empty while open), ' +
      'Completed or Present, and the number of corrections.',
    type: 'array',
    items: { type: 'array', items: { type: 'string' } },
  })
  rows!: string[][];
}
