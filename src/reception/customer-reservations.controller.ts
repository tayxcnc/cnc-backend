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
import {
  BOOKING_CHANGE_LIMIT,
  CustomerWriteThrottle,
} from '../auth/auth-throttle';
import type { CustomerPrincipal } from '../auth/customer-principal';
import {
  CurrentCustomer,
  MaybeCustomer,
} from '../auth/decorators/current-customer.decorator';
import { CncCustomerGuard } from '../auth/guards/cnc-customer.guard';
import { OptionalCustomerGuard } from '../auth/guards/optional-customer.guard';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { PaginationQuery } from '../common/dto/pagination.query';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import {
  IdempotencyKey,
  type IdempotencyRequest,
  IdempotentRoute,
} from '../idempotency/idempotency-key.decorator';
import { idempotencyScope } from '../idempotency/idempotency-scope';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { BookingThrottle } from './booking-throttle';
import { CustomerReservationsService } from './customer-reservations.service';
import {
  CustomerReservationChangeRequest,
  CustomerReservationPageResponse,
  CustomerReservationResponse,
  WebReservationRequest,
} from './dto/customer-reservation.dto';
import { ReservationCommandRequest } from './dto/reservation.request';

const UNAUTHORISED = {
  status: 401,
  description: 'No valid customer token, or the account is gone or deleted.',
  type: ApiErrorResponse,
} as const;

const STAFF_TOKEN = {
  status: 403,
  description: 'A staff token.',
  type: ApiErrorResponse,
} as const;

const NOT_YOURS = {
  status: 404,
  description:
    '"We could not find that reservation." (also for another customer’s).',
  type: ApiErrorResponse,
} as const;

const CUSTOMER_TOO_MANY = {
  status: 429,
  description:
    '"Too many attempts. Wait a few minutes and try again." (per customer), ' +
    'with `Retry-After`.',
  type: ApiErrorResponse,
} as const;

/**
 * `POST /reservations` (plan §5.1, card C6-5): the website's and the
 * app's booking, through Reception's one booking command. No sign-in is
 * needed; with a customer token the booking is the app's and the
 * customer's own.
 */
@ApiTags('Public')
@Controller('reservations')
export class PublicReservationsController {
  constructor(
    private readonly reservations: CustomerReservationsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(OptionalCustomerGuard, ClientAddressThrottlerGuard)
  @BookingThrottle()
  @IdempotentRoute()
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth()
  @ApiOperation({
    operationId: 'createReservation',
    summary: 'Book a table from the website or the app',
    description:
      'Draws `RSV-` and holds the table for the whole date until staff ' +
      'free it. The arrival must be one of the date’s `arrivalTimes`; a ' +
      'party at the room’s `bigParty` or more goes to the team instead. ' +
      'Takes an Idempotency-Key, so a retry books once; a second booking ' +
      'for the table and date is refused, by the database when two arrive ' +
      'at once. Without a token the booking is the website’s and links to ' +
      'a customer only with the same verified email (Q35); with a customer ' +
      'token it is the app’s and theirs. The confirmation is emailed.',
  })
  @ApiResponse({ status: 201, type: CustomerReservationResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Please add a name for the reservation.", "Please add a Nigerian ' +
      'phone number, for example 0803 123 4567.", "Please add a valid ' +
      'email address so we can send your confirmation.", "Choose a ' +
      'position with enough capacity.", the large-party note ("For four ' +
      'or more guests, speak to our team…"), "Select a future reservation ' +
      'time.", "CNC is closed on that date. Choose another date.", "Choose ' +
      'one of the arrival times offered.", or a missing Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'A customer token that fails verification.',
    type: ApiErrorResponse,
  })
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse({
    status: 409,
    description:
      '"Someone has just taken this place for that time. Go back to the ' +
      'floor plan and choose another.", or a reused Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 429,
    description: '"Too many attempts. Wait a few minutes and try again."',
    type: ApiErrorResponse,
  })
  async create(
    @MaybeCustomer() customer: CustomerPrincipal | null,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: WebReservationRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerReservationResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute({
      ...idempotency,
      scope:
        customer === null
          ? idempotencyScope.anonymous(ipAddress)
          : idempotencyScope.customer(customer.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.reservations.book(tx, customer, request, ipAddress),
    });

    await this.reservations.sendConfirmation(result.body.id);
    response.status(result.status);

    return result.body;
  }
}

/**
 * The signed-in customer's bookings (plan §5.2, card C6-6): the list, a
 * change of date, time or party, and a cancel, each of the customer's own
 * bookings only, and the last two at least 24 hours before the booking
 * (Q6). Personal data: never stored by a cache.
 */
@ApiTags('Customer account')
@ApiBearerAuth()
@UseGuards(CncCustomerGuard)
@Controller('me/reservations')
export class CustomerReservationsController {
  constructor(private readonly reservations: CustomerReservationsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'myReservations',
    summary: 'My bookings',
    description:
      'Latest date first. `changeable` says whether the change and cancel ' +
      'buttons are on: Confirmed and at least 24 hours away by the ' +
      'server’s clock.',
  })
  @ApiResponse({ status: 200, type: CustomerReservationPageResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  list(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Query() query: PaginationQuery,
  ): Promise<CustomerReservationPageResponse> {
    return this.reservations.list(customer.id, query);
  }

  @Patch(':id')
  @UseGuards(ClientAddressThrottlerGuard)
  @CustomerWriteThrottle(BOOKING_CHANGE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiParam({ name: 'id', description: 'Reservation.id.' })
  @ApiOperation({
    operationId: 'myReservationChange',
    summary: 'Change my booking’s date, time or party',
    description:
      'At least 24 hours before the booking (Q6). The table stays; the new ' +
      'arrival is checked as a website booking is.',
  })
  @ApiResponse({ status: 200, type: CustomerReservationResponse })
  @ApiResponse({
    status: 400,
    description:
      '"<Table> seats up to <n>. For a larger party, book a bigger ' +
      'table.", the large-party note, "Choose an arrival time that is ' +
      'still open.", "CNC is closed on that date. Choose another date.", ' +
      'or a bad field.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse(NOT_YOURS)
  @ApiResponse({
    status: 409,
    description:
      '"Your reservation is less than 24 hours away. Nothing is charged, ' +
      'but please call CNC if you can no longer come.", "Only confirmed ' +
      'reservations can be changed.", "<Table> is already taken at that ' +
      'time. Try another time.", or "This record changed. Refresh and try ' +
      'again."',
    type: ApiErrorResponse,
  })
  @ApiResponse(CUSTOMER_TOO_MANY)
  change(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Param('id') id: string,
    @Body() request: CustomerReservationChangeRequest,
    @Req() httpRequest: Request,
  ): Promise<CustomerReservationResponse> {
    return this.reservations.change(
      customer,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientAddressThrottlerGuard)
  @CustomerWriteThrottle(BOOKING_CHANGE_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiParam({ name: 'id', description: 'Reservation.id.' })
  @ApiOperation({
    operationId: 'myReservationCancel',
    summary: 'Cancel my booking',
    description:
      'At least 24 hours before the booking (Q6); frees the table. Nothing ' +
      'is charged.',
  })
  @ApiResponse({ status: 200, type: CustomerReservationResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse(NOT_YOURS)
  @ApiResponse({
    status: 409,
    description:
      'The 24-hour sentence, "Only confirmed reservations can be ' +
      'cancelled.", or a stale version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(CUSTOMER_TOO_MANY)
  cancel(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Param('id') id: string,
    @Body() request: ReservationCommandRequest,
    @Req() httpRequest: Request,
  ): Promise<CustomerReservationResponse> {
    return this.reservations.cancel(
      customer,
      id,
      request.version,
      clientAddressOf(httpRequest),
    );
  }
}
