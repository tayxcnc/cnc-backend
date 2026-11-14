import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { OrderCancelResponse, OrderResponse } from './dto/order.response';
import {
  DiscountOrderRequest,
  OrderCorrectionRequest,
  PartPaymentRequest,
  ProceedToPaymentRequest,
  SettleOrderRequest,
} from './dto/payment.request';
import { OrderPaymentsService } from './order-payments.service';

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

const STALE = '"This record changed. Refresh and try again."';

const PAYMENT_LIST =
  '"Payment information is missing.", "Payment amounts must be ' +
  'positive.", "Invalid payment method.", "Transfer payments require the ' +
  'sender name and reference."';

const ID_PARAM = { name: 'id', description: 'Order.id.' } as const;

/**
 * Point of Sale's money (plan §5.4, §6.2; card C4-5): Proceed to Payment,
 * part payments and settlement, and the corrections. A controller of its
 * own beside `OrdersController`, because its routes carry different roles
 * each, and the reversal none at all: the demo answers every non-Owner
 * "Only the Owner can reverse a paid bill.", which a role guard would
 * answer with the role sentence first.
 */
@ApiTags('Point of Sale')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/orders')
export class OrderPaymentsController {
  constructor(
    private readonly payments: OrderPaymentsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post(':id/payment')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.CASHIER, StaffRole.WAITER, StaffRole.BARTENDER)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOrderProceedToPayment',
    summary: 'Proceed to payment (order.payment)',
    description:
      'An open bill with lines moves to awaiting payment, which locks its ' +
      'items. A Restaurant bill’s lines must equal its latest docket.',
  })
  @ApiResponse({ status: 200, type: OrderResponse })
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
      '"Only open orders can proceed to payment.", "Add at least one ' +
      'item.", "Confirm the latest food items and print the kitchen docket ' +
      `first.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  proceedToPayment(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: ProceedToPaymentRequest,
    @Req() httpRequest: Request,
  ): Promise<OrderResponse> {
    return this.payments.proceedToPayment(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/part-payments')
  @HttpCode(HttpStatus.CREATED)
  @Roles(StaffRole.CASHIER, StaffRole.WAITER, StaffRole.BARTENDER)
  @IdempotentRoute()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOrderPartPayment',
    summary: 'Take a part payment (order.partPay)',
    description:
      'Money against a bill awaiting payment, together less than its ' +
      'balance; a split is several payments. Each gets a `PAY-` number. ' +
      'Takes an Idempotency-Key, so a retry does not take the money twice.',
  })
  @ApiResponse({ status: 201, type: OrderResponse })
  @ApiResponse({
    status: 400,
    description:
      `${PAYMENT_LIST}, "A part payment must be less than the balance. ` +
      'Use settlement for the full balance.", a bad version, or a missing ' +
      'Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"Proceed to payment before taking a part payment.", ' +
      `${STALE}, or a reused Idempotency-Key.`,
    type: ApiErrorResponse,
  })
  async partPay(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Param('id') id: string,
    @Body() request: PartPaymentRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.payments.partPay(tx, actor, id, request, ipAddress),
    });

    response.status(result.status);

    return result.body;
  }

  @Post(':id/settle')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.CASHIER, StaffRole.WAITER, StaffRole.BARTENDER)
  @IdempotentRoute()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOrderSettle',
    summary: 'Settle the bill (order.settle)',
    description:
      'Payments that cover what is left exactly: the total less part ' +
      'payments and any deposit credit. A Bar bill’s drinks leave the Bar ' +
      'here, once; a Bar short of a drink refuses the settlement. Two ' +
      'settles of one version: one settles, the other is refused as ' +
      'stale. Takes an Idempotency-Key, so a retry does not settle twice.',
  })
  @ApiResponse({ status: 200, type: OrderResponse })
  @ApiResponse({
    status: 400,
    description:
      `${PAYMENT_LIST}, "Payment amounts must exactly cover the remaining ` +
      'balance.", "Invalid deposit credit.", "Choose a checked-in ' +
      'reservation for this table.", a bad version, or a missing ' +
      'Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  @ApiResponse({
    status: 404,
    description:
      '"Order not found.", or "Stock item not found." (a drink ' +
      'with no paired Bar stock item).',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description:
      '"Proceed to payment before settlement. This order may already be ' +
      'settled.", "Insufficient bar stock for <drink>.", "That deposit ' +
      `credit has already been used.", ${STALE}, or a reused ` +
      'Idempotency-Key.',
    type: ApiErrorResponse,
  })
  async settle(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Param('id') id: string,
    @Body() request: SettleOrderRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.OK,
      work: (tx) => this.payments.settle(tx, actor, id, request, ipAddress),
    });

    response.status(result.status);

    return result.body;
  }

  @Post(':id/discount')
  @HttpCode(HttpStatus.OK)
  @Roles()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOrderDiscount',
    summary: 'Discount the bill (order.discount)',
    description:
      'Managers, with a reason, before Proceed to Payment on the bill’s ' +
      'opening date. The whole discount, up to the subtotal. Above the ' +
      'Owner Approval Limit only the Owner may give it; the increase counts ' +
      'toward the manager’s Daily Approval Limit.',
  })
  @ApiResponse({ status: 200, type: OrderResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Invalid discount.", "An admin correction requires a reason.", or ' +
      'a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      '"Your current staff role cannot perform this action.", "This ' +
      'discount is above the Owner Approval Limit of ₦50,000. The Owner ' +
      'must approve it.", or the Daily Approval Limit sentence.',
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"Discounts must be applied before proceeding to payment on the ' +
      `opening date.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  discount(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: DiscountOrderRequest,
    @Req() httpRequest: Request,
  ): Promise<OrderResponse> {
    return this.payments.discount(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOrderCancel',
    summary: 'Cancel the bill (order.cancel)',
    description:
      'Managers, with a reason: an open or awaiting-payment bill with no ' +
      'money against it. A Restaurant bill the kitchen was sent gets a ' +
      'cancellation docket (a new revision with no items) to print.',
  })
  @ApiResponse({ status: 200, type: OrderCancelResponse })
  @ApiResponse({
    status: 400,
    description: '"An admin correction requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description: '"Your current staff role cannot perform this action."',
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"Only unpaid bills can be cancelled.", "This bill has part ' +
      'payments. Settle the balance instead of cancelling.", or ' +
      STALE,
    type: ApiErrorResponse,
  })
  cancel(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: OrderCorrectionRequest,
    @Req() httpRequest: Request,
  ): Promise<OrderCancelResponse> {
    return this.payments.cancel(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  @Roles()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOrderReopen',
    summary: 'Reopen the bill (order.reopen)',
    description:
      'Managers, with a reason: a bill awaiting payment goes back to open ' +
      'so its items can change, on its opening date only.',
  })
  @ApiResponse({ status: 200, type: OrderResponse })
  @ApiResponse({
    status: 400,
    description: '"An admin correction requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description: '"Your current staff role cannot perform this action."',
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"Only orders awaiting payment can be reopened here.", ' +
      '"Previous-day items remain locked. Create a new order for new ' +
      `items.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  reopen(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: OrderCorrectionRequest,
    @Req() httpRequest: Request,
  ): Promise<OrderResponse> {
    return this.payments.reopen(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/reverse')
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOrderReverse',
    summary: 'Reverse a settlement (order.reverse)',
    description:
      'The Owner only, with a reason (D35): a settled till bill goes back ' +
      'to awaiting payment, its payments are marked reversed, and a Bar ' +
      'bill’s drinks return to the Bar.',
  })
  @ApiResponse({ status: 200, type: OrderResponse })
  @ApiResponse({
    status: 400,
    description: '"An admin correction requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description: '"Only the Owner can reverse a paid bill."',
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: `"Select a settled POS order.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  reverse(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: OrderCorrectionRequest,
    @Req() httpRequest: Request,
  ): Promise<OrderResponse> {
    return this.payments.reverse(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }
}
