import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import {
  FloorResponse,
  TableReleaseResponse,
  TableSessionResponse,
} from './dto/reception.response';
import {
  AllocateTableRequest,
  FloorQuery,
  ReleaseTableRequest,
} from './dto/table.request';
import { TableSessionsService } from './table-sessions.service';

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

const TABLE_NOT_FOUND = {
  status: 404,
  description: '"Table not found."',
  type: ApiErrorResponse,
} as const;

const ID_PARAM = { name: 'id', description: 'DiningTable.id.' } as const;

/**
 * Reception's tables (plan §5.4, §6.2: R(Reception); card C4-7): seating
 * walk-in guests, locking and freeing a table. Reception and managers.
 */
@ApiTags('Reception')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Roles(StaffRole.RECEPTION)
@Controller('staff/tables')
export class TablesController {
  constructor(private readonly sessions: TableSessionsService) {}

  @Post(':id/allocate')
  @HttpCode(HttpStatus.CREATED)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffTableAllocate',
    summary: 'Seat guests or lock a table (table.allocate)',
    description:
      'Occupied: walk-in guests, with a guest name and a party within the ' +
      'table’s places. Locked: out of use, with a reason. The table stays ' +
      'so until it is released.',
  })
  @ApiResponse({ status: 201, type: TableSessionResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Invalid table status.", "Enter a guest name and a party size ' +
      'within capacity.", or "Enter a reason for locking this position."',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(TABLE_NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"Release this position before allocating it again.", or "This ' +
      'position is reserved. Check in or resolve the reservation first."',
    type: ApiErrorResponse,
  })
  allocate(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: AllocateTableRequest,
    @Req() httpRequest: Request,
  ): Promise<TableSessionResponse> {
    return this.sessions.allocate(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffTableRelease',
    summary: 'Free a table (table.release)',
    description:
      'Ends the named seating or lock. Refused while a bill on the table ' +
      'is Open or awaiting payment, of any date. The table’s Checked In ' +
      'bookings become Completed.',
  })
  @ApiResponse({ status: 200, type: TableReleaseResponse })
  @ApiResponse({
    status: 400,
    description: 'A missing seating or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(TABLE_NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"No active allocation.", "There are unsettled orders for this ' +
      'position. Settle them before release.", or "This record changed. ' +
      'Refresh and try again."',
    type: ApiErrorResponse,
  })
  release(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: ReleaseTableRequest,
    @Req() httpRequest: Request,
  ): Promise<TableReleaseResponse> {
    return this.sessions.release(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }
}

/**
 * The floor (plan §5.4: Reception's `GET /staff/floor?venue&date`, and the
 * till's table picker). Reception and managers read any date; the Point
 * of Sale roles read today only, without guests' contacts (§6.1).
 */
@ApiTags('Reception')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Roles(
  StaffRole.RECEPTION,
  StaffRole.CASHIER,
  StaffRole.WAITER,
  StaffRole.BARTENDER,
)
@Controller('staff/floor')
export class FloorController {
  constructor(private readonly sessions: TableSessionsService) {}

  @Get()
  @ApiOperation({
    operationId: 'staffFloor',
    summary: 'The floor for a date',
    description:
      'Every table in use with its status for the date (Available, ' +
      'Occupied, Reserved, Locked), its open seating with the Free Table ' +
      'Reminder flag, the date’s bookings and its unsettled bills. Point ' +
      'of Sale roles: today only, no phone or email, a Bartender’s bills ' +
      'Bar only.',
  })
  @ApiResponse({ status: 200, type: FloorResponse })
  @ApiResponse({
    status: 400,
    description: '"Choose a venue.", or "Enter a valid reservation date."',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      '"Your current staff role cannot perform this action.", also for a ' +
      'Point of Sale role asking for another date.',
    type: ApiErrorResponse,
  })
  floor(
    @CurrentStaff() actor: StaffPrincipal,
    @Query() query: FloorQuery,
  ): Promise<FloorResponse> {
    return this.sessions.floor(actor, query);
  }
}
