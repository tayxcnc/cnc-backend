import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
import {
  ConfirmOrderRequest,
  CreateOrderRequest,
  OrderListQuery,
  SetOrderLineRequest,
  UpdateOrderDetailsRequest,
} from './dto/order.request';
import {
  OrderConfirmResponse,
  OrderPageResponse,
  OrderResponse,
} from './dto/order.response';
import { OrdersService } from './orders.service';

const UNAUTHORISED = {
  status: 401,
  description: 'No bearer token, or one that fails verification.',
  type: ApiErrorResponse,
} as const;

const REFUSED = {
  status: 403,
  description:
    '"Your current staff role cannot perform this action.", or ' +
    '"Bartenders can operate Bar POS only."',
  type: ApiErrorResponse,
} as const;

const NOT_FOUND = {
  status: 404,
  description: '"Order not found."',
  type: ApiErrorResponse,
} as const;

const LOCKED_OR_STALE = {
  status: 409,
  description:
    '"This order belongs to a previous day. Create a new order to add ' +
    'items.", "This order is locked. A manager must reopen it before ' +
    'editing.", or "This record changed. Refresh and try again."',
  type: ApiErrorResponse,
} as const;

const ID_PARAM = { name: 'id', description: 'Order.id.' } as const;

/** The Point of Sale roles (plan §6.2: R(Cashier, Waiter, Bartender)). */
const POS_ROLES = [
  StaffRole.CASHIER,
  StaffRole.WAITER,
  StaffRole.BARTENDER,
] as const;

/**
 * Point of Sale's bills, lines and kitchen confirm (plan §5.4; cards C4-3
 * and C4-4). Cashier, Waiter and Bartender (the Bar only), and managers.
 * Payments, settlement and the manager corrections (C4-5) are
 * `OrderPaymentsController`'s.
 */
@ApiTags('Point of Sale')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Roles(...POS_ROLES)
@Controller('staff/orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'staffOrders',
    summary: 'A department’s bills',
    description:
      'By state (active by default: open or awaiting payment) and the ' +
      'till’s filter chips, with each bill’s total, money received and ' +
      'balance, and the chip counts. A Bartender reads the Bar only.',
  })
  @ApiResponse({ status: 200, type: OrderPageResponse })
  @ApiResponse({
    status: 400,
    description: '"Choose a department.", or a bad filter or page.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  list(
    @CurrentStaff() actor: StaffPrincipal,
    @Query() query: OrderListQuery,
  ): Promise<OrderPageResponse> {
    return this.orders.list(actor, query);
  }

  @Get(':id')
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOrder',
    summary: 'One bill',
    description:
      'The bill with its lines, totals, payments, latest kitchen docket, ' +
      'usable reservation credit and the `version` the next write names.',
  })
  @ApiResponse({ status: 200, type: OrderResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  @ApiResponse(NOT_FOUND)
  detail(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
  ): Promise<OrderResponse> {
    return this.orders.detail(actor, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffOrderCreate',
    summary: 'Open a bill (order.create)',
    description:
      'Draws `CNCR-` (Restaurant) or `CNCB-` (Bar). Today’s business date ' +
      'and the current VAT and service rates are fixed on the bill. Takes ' +
      'an Idempotency-Key, so a retry after a lost response opens one bill.',
  })
  @ApiResponse({ status: 201, type: OrderResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose a department.", "Select a valid table.", or a missing ' +
      'Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  @ApiResponse({
    status: 409,
    description:
      'The Idempotency-Key was already used for a different request.',
    type: ApiErrorResponse,
  })
  async create(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: CreateOrderRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.orders.create(tx, actor, request, ipAddress),
    });

    response.status(result.status);

    return result.body;
  }

  @Put(':id/lines')
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOrderSetLine',
    summary: 'Set a line’s quantity (order.quantity)',
    description:
      'One dish plus its option, set to an absolute quantity (0 removes ' +
      'it), on an open bill of today. A dish with a choice needs one of ' +
      'its options. A new line takes the current price; an existing one ' +
      'keeps its own.',
  })
  @ApiResponse({ status: 200, type: OrderResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter a whole number zero or above.", "Maximum item quantity is ' +
      '999.", "This item is unavailable in the selected department.", ' +
      '"Choose style for Pancakes.", "This item has no options.", or a ' +
      'bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(LOCKED_OR_STALE)
  setLine(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: SetOrderLineRequest,
    @Req() httpRequest: Request,
  ): Promise<OrderResponse> {
    return this.orders.setLine(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Patch(':id')
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOrderDetails',
    summary: 'Change the guest or notes (order.details)',
    description:
      'On an open bill of today. Only the fields sent change. The notes ' +
      'print on the next docket revision.',
  })
  @ApiResponse({ status: 200, type: OrderResponse })
  @ApiResponse({
    status: 400,
    description: 'Text too long, or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(LOCKED_OR_STALE)
  updateDetails(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: UpdateOrderDetailsRequest,
    @Req() httpRequest: Request,
  ): Promise<OrderResponse> {
    return this.orders.updateDetails(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOrderConfirm',
    summary: 'Send to the kitchen (order.confirm)',
    description:
      'Restaurant bills only. Writes docket revision n+1 (`KOT-<number>`) ' +
      'with the full list of lines; with nothing changed since the latest ' +
      'docket, returns it to print again (`reprint: true`) and writes no ' +
      'revision. Allowed after midnight for a carried bill, under its own ' +
      'business date.',
  })
  @ApiResponse({ status: 200, type: OrderConfirmResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"Only open orders can be confirmed.", "Add items before ' +
      'confirming.", "Bar orders do not use kitchen dockets.", or "This ' +
      'record changed. Refresh and try again."',
    type: ApiErrorResponse,
  })
  confirm(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: ConfirmOrderRequest,
    @Req() httpRequest: Request,
  ): Promise<OrderConfirmResponse> {
    return this.orders.confirm(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }
}
