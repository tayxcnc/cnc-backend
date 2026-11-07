import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { StaffRole } from '../../generated/cnc-client';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { AttendanceService } from './attendance.service';
import {
  AttendanceExportQuery,
  AttendancePeopleQuery,
  AttendanceQuery,
  CorrectAttendanceRequest,
  ScanAttendanceRequest,
} from './dto/attendance.request';
import {
  AttendanceDirectoryResponse,
  AttendanceExportResponse,
  AttendancePageResponse,
  AttendanceRecordResponse,
  ScanAttendanceResponse,
} from './dto/attendance.response';

const UNAUTHORISED = {
  status: 401,
  description: 'No bearer token, or one that fails verification.',
  type: ApiErrorResponse,
} as const;

const ROLE_REFUSED = {
  status: 403,
  description: '"Your current staff role cannot perform this action."',
  type: ApiErrorResponse,
} as const;

const PERIOD_REFUSED = {
  status: 400,
  description:
    '"Choose a valid month.", "Choose valid start and end dates.", "The ' +
    'end date must follow the start date.", "Choose a period of 366 days ' +
    'or fewer.", "Choose All Shifts, Completed or Open Shifts.", or a bad ' +
    'page.',
  type: ApiErrorResponse,
} as const;

const STAFF_NOT_FOUND = {
  status: 404,
  description: '"Staff account not found."',
  type: ApiErrorResponse,
} as const;

const STAFF_PARAM = { name: 'staffId', description: 'Staff.id.' } as const;

/**
 * Attendance (plan §5.3, §5.4; card C5-7; Q12's default: timestamps only):
 * Reception's QR scan, the managers' Attendance screen and its Attendance
 * review export, and everyone's own My Attendance.
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post('attendance/scan')
  @Roles(StaffRole.RECEPTION)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'staffAttendanceScan',
    summary: 'Record a staff ID scan (attendance.scan)',
    description:
      'Reception and managers, from the camera or a USB scanner. Checks ' +
      'the person in, or out of their open shift from an hour after the ' +
      'check-in (overnight included). A scan within that hour, or within ' +
      'a minute of the check-out, is ignored and records nothing. The ' +
      'code is compared and never returned, logged or audited. Takes no ' +
      'Idempotency-Key: a retry is the ignored repeat.',
  })
  @ApiResponse({ status: 200, type: ScanAttendanceResponse })
  @ApiResponse({
    status: 400,
    description: '"This staff QR code is invalid or the account is inactive."',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 409,
    description: '"Check-out must follow arrival."',
    type: ApiErrorResponse,
  })
  scan(
    @CurrentStaff() actor: StaffPrincipal,
    @Body() request: ScanAttendanceRequest,
    @Req() httpRequest: Request,
  ): Promise<ScanAttendanceResponse> {
    return this.attendance.scan(
      actor,
      request.code,
      clientAddressOf(httpRequest),
    );
  }

  @Get('me/attendance')
  @ApiOperation({
    operationId: 'staffMyAttendance',
    summary: 'My Attendance',
    description:
      'Every member of staff, their own shifts for a month (this month by ' +
      'default) with the summary; read only.',
  })
  @ApiResponse({ status: 200, type: AttendancePageResponse })
  @ApiResponse(PERIOD_REFUSED)
  @ApiResponse(UNAUTHORISED)
  myAttendance(
    @CurrentStaff() actor: StaffPrincipal,
    @Query() query: AttendanceQuery,
  ): Promise<AttendancePageResponse> {
    return this.attendance.records(actor.id, query);
  }

  // Declared before `attendance/:staffId`, which would otherwise take
  // `people` as a staff id.
  @Get('attendance/people')
  @Roles()
  @ApiOperation({
    operationId: 'staffAttendancePeople',
    summary: 'The Attendance directory',
    description: 'Managers: the active staff, by name.',
  })
  @ApiResponse({ status: 200, type: AttendanceDirectoryResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad page or search.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  people(
    @Query() query: AttendancePeopleQuery,
  ): Promise<AttendanceDirectoryResponse> {
    return this.attendance.people(query);
  }

  @Get('attendance/:staffId')
  @Roles()
  @ApiParam(STAFF_PARAM)
  @ApiOperation({
    operationId: 'staffAttendance',
    summary: 'A person’s attendance',
    description:
      'Managers: a month (this month by default) or a range of arrival ' +
      'dates, each shift with its corrections, and the summary.',
  })
  @ApiResponse({ status: 200, type: AttendancePageResponse })
  @ApiResponse(PERIOD_REFUSED)
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(STAFF_NOT_FOUND)
  records(
    @Param('staffId') staffId: string,
    @Query() query: AttendanceQuery,
  ): Promise<AttendancePageResponse> {
    return this.attendance.records(staffId, query);
  }

  @Get('attendance/:staffId/export')
  @Roles()
  @ApiParam(STAFF_PARAM)
  @ApiOperation({
    operationId: 'staffAttendanceExport',
    summary: 'The Attendance review export',
    description:
      'Managers: every shift of the period as the export’s rows, titled ' +
      '"Attendance review" (Q12), for the staff app’s CSV, PDF and print ' +
      'preview. No pay is calculated and no absence assumed.',
  })
  @ApiResponse({ status: 200, type: AttendanceExportResponse })
  @ApiResponse(PERIOD_REFUSED)
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(STAFF_NOT_FOUND)
  exportReview(
    @Param('staffId') staffId: string,
    @Query() query: AttendanceExportQuery,
  ): Promise<AttendanceExportResponse> {
    return this.attendance.export(staffId, query);
  }

  @Patch('attendance/:id')
  @Roles()
  @ApiParam({ name: 'id', description: 'AttendanceRecord.id.' })
  @ApiOperation({
    operationId: 'staffAttendanceCorrect',
    summary: 'Correct a shift (attendance.correct)',
    description:
      'Managers, with a reason. The times replaced stay in the shift’s ' +
      'corrections.',
  })
  @ApiResponse({ status: 200, type: AttendanceRecordResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter valid attendance times.", "Attendance cannot be in the ' +
      'future.", "Check-out must follow check-in.", "An admin correction ' +
      'requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 404,
    description: '"Attendance record not found."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description:
      '"This correction overlaps another shift.", or "This record ' +
      'changed. Refresh and try again."',
    type: ApiErrorResponse,
  })
  correct(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: CorrectAttendanceRequest,
    @Req() httpRequest: Request,
  ): Promise<AttendanceRecordResponse> {
    return this.attendance.correct(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }
}
