import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { StaffRole } from '../../generated/cnc-client';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import {
  IdempotencyKey,
  type IdempotencyRequest,
  IdempotentRoute,
} from '../idempotency/idempotency-key.decorator';
import { idempotencyScope } from '../idempotency/idempotency-scope';
import { IdempotencyService } from '../idempotency/idempotency.service';
import type { PushTopics } from '../push/push-queue.service';
import {
  CheckInResponse,
  ReservationPageResponse,
  ReservationResponse,
} from './dto/reception.response';
import {
  ChangeReservationRequest,
  CreateReservationRequest,
  ReservationCommandRequest,
  ReservationListQuery,
} from './dto/reservation.request';
import { ReservationsService } from './reservations.service';

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

const NOT_FOUND = {
  status: 404,
  description: '"Reservation not found."',
  type: ApiErrorResponse,
} as const;

const ID_PARAM = { name: 'id', description: 'Reservation.id.' } as const;

/**
 * Reception's bookings (plan §5.4, §6.2: R(Reception); card C4-7).
 * Reception and managers. The website's and the app's bookings (C6-5)
 * run the same command from their own routes.
 */
@ApiTags('Reception')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Roles(StaffRole.RECEPTION)
@Controller('staff/reservations')
export class ReservationsController {
  constructor(
    private readonly reservations: ReservationsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'staffReservations',
    summary: 'Bookings for a date, or every date',
    description:
      'One date’s bookings (today by default) or, with `all=true`, every ' +
      'date’s (History), by date and arrival time. Search by guest name, ' +
      'booking number or phone.',
  })
  @ApiResponse({ status: 200, type: ReservationPageResponse })
  @ApiResponse({
    status: 400,
    description: '"Enter a valid reservation date.", or a bad page.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  list(@Query() query: ReservationListQuery): Promise<ReservationPageResponse> {
    return this.reservations.list(query);
  }

  @Get(':id')
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffReservation',
    summary: 'One booking',
  })
  @ApiResponse({ status: 200, type: ReservationResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(NOT_FOUND)
  detail(@Param('id') id: string): Promise<ReservationResponse> {
    return this.reservations.detail(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffReservationCreate',
    summary: 'Book a table (reservation.create)',
    description:
      'Draws `RSV-`. The booking holds its table for the whole date until ' +
      'staff free it. Reception books within the opening hours (Q30). ' +
      'Takes an Idempotency-Key, so a retry after a lost response books ' +
      'once. A second booking for the table and date is refused, by the ' +
      'database when two arrive at once.',
  })
  @ApiResponse({ status: 201, type: ReservationResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter the guest name and phone number.", "Enter the guest email so ' +
      'the confirmation can be sent.", "Choose a position with enough ' +
      'capacity.", "Select a future reservation time.", "CNC is closed on ' +
      'that date. Choose another date.", "Choose an arrival time within ' +
      'opening hours.", a bad date or time, or a missing Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 409,
    description:
      '"This position is already reserved for that date. A booking keeps ' +
      'its table until staff free it.", "This position is locked.", ' +
      '"Guests are at this position now. Free it before booking it for ' +
      'today.", or a reused Idempotency-Key.',
    type: ApiErrorResponse,
  })
  async create(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: CreateReservationRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReservationResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const pushes: PushTopics = [];
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) =>
        this.reservations.create(tx, actor, request, ipAddress, pushes),
    });

    await this.reservations.sendConfirmation(result.body.id, pushes);
    response.status(result.status);

    return result.body;
  }

  @Patch(':id')
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffReservationChange',
    summary: 'Change a booking (reservation.change)',
    description:
      'Reception’s "Change booking" (new). A Confirmed booking’s guest, ' +
      'contact, note, party, table, date or time; only the fields sent ' +
      'change, and what they touch is checked as a new booking would be.',
  })
  @ApiResponse({ status: 200, type: ReservationResponse })
  @ApiResponse({
    status: 400,
    description: 'The create sentences, or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"Only confirmed reservations can be changed.", the create’s table ' +
      'sentences, or "This record changed. Refresh and try again."',
    type: ApiErrorResponse,
  })
  change(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: ChangeReservationRequest,
    @Req() httpRequest: Request,
  ): Promise<ReservationResponse> {
    return this.reservations.change(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/check-in')
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffReservationCheckIn',
    summary: 'Check guests in (reservation.checkin)',
    description:
      'On the booking date, a Confirmed booking becomes Checked In and its ' +
      'table Occupied by the booked guests.',
  })
  @ApiResponse({ status: 200, type: CheckInResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"Select a confirmed reservation.", "Check-in must be on the ' +
      'reservation date.", "Release the existing table allocation ' +
      'first.", or "This record changed. Refresh and try again."',
    type: ApiErrorResponse,
  })
  checkIn(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: ReservationCommandRequest,
    @Req() httpRequest: Request,
  ): Promise<CheckInResponse> {
    return this.reservations.checkIn(
      actor,
      id,
      request.version,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffReservationCancel',
    summary: 'Cancel a booking (reservation.cancel)',
    description: 'Before the booking time; frees the table for the date.',
  })
  @ApiResponse({ status: 200, type: ReservationResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"Only confirmed reservations can be cancelled.", "Cancel before the ' +
      'booking time. Later, mark the booking as a no show.", or a stale ' +
      'version.',
    type: ApiErrorResponse,
  })
  cancel(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: ReservationCommandRequest,
    @Req() httpRequest: Request,
  ): Promise<ReservationResponse> {
    return this.reservations.cancel(
      actor,
      id,
      request.version,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/no-show')
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffReservationNoShow',
    summary: 'Mark a no show (reservation.noshow)',
    description: 'After the booking time; frees the table for the date.',
  })
  @ApiResponse({ status: 200, type: ReservationResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"Only confirmed reservations can be marked as a no show.", "The ' +
      'booking time has not passed yet.", or a stale version.',
    type: ApiErrorResponse,
  })
  noShow(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: ReservationCommandRequest,
    @Req() httpRequest: Request,
  ): Promise<ReservationResponse> {
    return this.reservations.noShow(
      actor,
      id,
      request.version,
      clientAddressOf(httpRequest),
    );
  }
}
