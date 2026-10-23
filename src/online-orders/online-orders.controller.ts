import {
  BadGatewayException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
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
import { OnlineRefundStatus, StaffRole } from '../../generated/cnc-client';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { CncConfigService } from '../config/cnc.config';
import {
  IdempotencyKey,
  type IdempotencyRequest,
  IdempotentRoute,
} from '../idempotency/idempotency-key.decorator';
import { idempotencyScope } from '../idempotency/idempotency-scope';
import { IdempotencyService } from '../idempotency/idempotency.service';
import {
  OnlineBalanceMethod,
  OnlineBalanceRequest,
  OnlineCancelRequest,
  OnlineCorrectStatusRequest,
  OnlineEditRequest,
  OnlineOrderListQuery,
  OnlineStatusRequest,
  OnlineZoneRequest,
} from './dto/online-order.request';
import {
  OnlineOrderChangeResponse,
  OnlineOrderPageResponse,
  OnlineOrderResponse,
} from './dto/online-order.response';
import {
  CARD_REFUNDS_UNAVAILABLE_MESSAGE,
  REFUND_REFUSED_MESSAGE,
  REFUND_UNCONFIRMED_MESSAGE,
} from './online-order-messages';
import {
  type BalanceRecorded,
  OnlineOrdersService,
} from './online-orders.service';
import { OnlineRefundsService } from './online-refunds.service';

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
  description: '"Online order not found."',
  type: ApiErrorResponse,
} as const;

const STALE = '"This record changed. Refresh and try again."';

const LIMITS =
  '"Your current staff role cannot perform this action.", the Owner ' +
  'Approval Limit sentence ("This change to a paid online order is above ' +
  'the Owner Approval Limit of ₦50,000. The Owner must approve it."), or ' +
  'the Daily Approval Limit sentence.';

const ID_PARAM = { name: 'id', description: 'OnlineOrder.id.' } as const;

/**
 * Online Orders (plan §5.4, §6.1, §6.2; card C7-4): the Cashier's and the
 * managers' screen for paid web orders. The Cashier moves an order to its
 * next stage; managers correct the stage, edit the lines (Restaurant and
 * Bar, D30), change the zone (Q27), cancel (Q8) and settle the money
 * (Q26, Q34), each with a reason, under the approval limits.
 *
 * Every command names the online order's `version` (A8); `balance` takes
 * an Idempotency-Key too (A9), because it moves money. A card refund is
 * recorded in that idempotent transaction and sent to Paystack after it
 * commits, once, whoever retries.
 */
@ApiTags('Online Orders')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/online-orders')
export class OnlineOrdersController {
  constructor(
    private readonly online: OnlineOrdersService,
    private readonly refunds: OnlineRefundsService,
    private readonly idempotency: IdempotencyService,
    private readonly config: CncConfigService,
  ) {}

  @Get()
  @Roles(StaffRole.CASHIER)
  @ApiOperation({
    operationId: 'staffOnlineOrders',
    summary: 'The Online Orders list',
    description:
      'ACTIVE: received, preparing, out for delivery or ready for pickup. ' +
      'HISTORY: delivered, collected or cancelled. Newest first, with what ' +
      'each order is worth, what was paid and what is still owed either way.',
  })
  @ApiResponse({ status: 200, type: OnlineOrderPageResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad tab, page or search.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  list(@Query() query: OnlineOrderListQuery): Promise<OnlineOrderPageResponse> {
    return this.online.list(query);
  }

  @Get(':id')
  @Roles(StaffRole.CASHIER)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOnlineOrder',
    summary: 'One online order',
    description:
      'The order, its bill (lines, payments, latest docket), its money, the ' +
      'managers’ adjustments and the card refunds.',
  })
  @ApiResponse({ status: 200, type: OnlineOrderResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(NOT_FOUND)
  detail(@Param('id') id: string): Promise<OnlineOrderResponse> {
    return this.online.detail(id);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.CASHIER)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOnlineOrderStatus',
    summary: 'Move to the next stage (online.status)',
    description:
      'The Cashier: the next stage only. Completed (DELIVERED or ' +
      'COLLECTED) once nothing is owed either way.',
  })
  @ApiResponse({ status: 200, type: OnlineOrderResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"This online order is closed.", "Move to the next fulfilment ' +
      'stage. Earlier statuses need a manager correction.", "Record the ' +
      'outstanding payment or refund before completing this order.", or ' +
      STALE,
    type: ApiErrorResponse,
  })
  status(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: OnlineStatusRequest,
    @Req() httpRequest: Request,
  ): Promise<OnlineOrderResponse> {
    return this.online.status(actor, id, request, clientAddressOf(httpRequest));
  }

  @Post(':id/correct-status')
  @HttpCode(HttpStatus.OK)
  @Roles()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOnlineOrderCorrectStatus',
    summary: 'Correct the stage (online.correctStatus)',
    description:
      'Managers, with a reason: any stage on the order’s own path, earlier ' +
      'ones included; not a cancelled order.',
  })
  @ApiResponse({ status: 200, type: OnlineOrderResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Invalid fulfilment status.", "Status does not match the delivery ' +
      'method.", "An admin correction requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"Select an online order.", "Record the outstanding payment or ' +
      `refund before completing this order.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  correctStatus(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: OnlineCorrectStatusRequest,
    @Req() httpRequest: Request,
  ): Promise<OnlineOrderResponse> {
    return this.online.correctStatus(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/edit')
  @HttpCode(HttpStatus.OK)
  @Roles()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOnlineOrderEdit',
    summary: 'Edit a paid order (online.edit)',
    description:
      'Managers, with a reason, before Completed (Q8): the whole new list ' +
      'of lines, Restaurant and Bar (D30), and the guest’s details. The ' +
      'difference is checked against the approval limits, counted toward ' +
      'the day and left as an adjustment for `balance`. The Bar moves by ' +
      'the drinks’ difference; the kitchen gets a new docket revision when ' +
      'the food or the note changed.',
  })
  @ApiResponse({ status: 200, type: OnlineOrderChangeResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Add at least one item.", "Combine duplicate items into one ' +
      'quantity.", "Quantities must be whole numbers above zero.", "Choose ' +
      'a Restaurant or Bar menu item.", "Choose <choice> for <dish>.", ' +
      '"<dish> has no options.", "Maximum item quantity is 999.", the phone ' +
      'sentence, "An admin correction requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({ status: 403, description: LIMITS, type: ApiErrorResponse })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: `"Select an active online order.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  edit(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: OnlineEditRequest,
    @Req() httpRequest: Request,
  ): Promise<OnlineOrderChangeResponse> {
    return this.online.edit(actor, id, request, clientAddressOf(httpRequest));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOnlineOrderCancel',
    summary: 'Cancel a paid order (online.cancel)',
    description:
      'Managers, with a reason, before Completed (Q8). Everything paid is ' +
      'then owed back (`balance`). Checked against the approval limits and ' +
      'counted. The drinks return to the Bar; a kitchen sent food gets a ' +
      'cancellation docket to print.',
  })
  @ApiResponse({ status: 200, type: OnlineOrderChangeResponse })
  @ApiResponse({
    status: 400,
    description: '"An admin correction requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({ status: 403, description: LIMITS, type: ApiErrorResponse })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: `"Select an active online order.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  cancel(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: OnlineCancelRequest,
    @Req() httpRequest: Request,
  ): Promise<OnlineOrderChangeResponse> {
    return this.online.cancel(actor, id, request, clientAddressOf(httpRequest));
  }

  @Post(':id/zone')
  @HttpCode(HttpStatus.OK)
  @Roles()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOnlineOrderZone',
    summary: 'Change the delivery details (online.zone)',
    description:
      'Managers, with a reason, before dispatch: the mode and address. The ' +
      'fee is recomputed from the fees the order snapshotted at checkout ' +
      '(Q27); the difference is checked against the approval limits, ' +
      'counted, and left as an adjustment for `balance`.',
  })
  @ApiResponse({ status: 200, type: OnlineOrderChangeResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Invalid delivery zone.", "Enter a delivery address.", the checkout’s ' +
      'address sentences, "An admin correction requires a reason.", or a ' +
      'bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({ status: 403, description: LIMITS, type: ApiErrorResponse })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"The delivery zone can only change before dispatch.", or ' + STALE,
    type: ApiErrorResponse,
  })
  zone(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: OnlineZoneRequest,
    @Req() httpRequest: Request,
  ): Promise<OnlineOrderChangeResponse> {
    return this.online.zone(actor, id, request, clientAddressOf(httpRequest));
  }

  @Post(':id/balance')
  @HttpCode(HttpStatus.OK)
  @Roles()
  @IdempotentRoute()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffOnlineOrderBalance',
    summary: 'Settle the money (online.balance)',
    description:
      'Managers, with a reason: records the whole balance as one payment. ' +
      'Extra money due is CASH or TRANSFER (Q34); a refund is CASH, ' +
      'TRANSFER, or PAYSTACK back to the card (Q26), never more than the ' +
      'card paid and has not had back. Checked against the approval limits ' +
      'and counted. A card refund is sent to Paystack once, after the ' +
      'record commits. Takes an Idempotency-Key.',
  })
  @ApiResponse({ status: 200, type: OnlineOrderResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose a payment method.", "Transfers require a sender/recipient ' +
      'and reference.", "Record extra money from the customer as Cash or ' +
      'Transfer.", "An admin correction requires a reason.", a bad ' +
      'version, or a missing Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description: LIMITS.replace(
      'This change to a paid online order',
      'This payment correction',
    ),
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"No payment adjustment is outstanding.", "A card refund cannot be ' +
      'more than the card payment not yet refunded. Record the rest as ' +
      `Cash or Transfer.", ${STALE}, or a reused Idempotency-Key.`,
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 502,
    description:
      'Paystack refused the card refund: nothing was sent, the refund is ' +
      'owed again.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 503,
    description:
      'Card refunds are not configured (nothing recorded), or Paystack’s ' +
      'answer did not arrive (the refund stays recorded, unconfirmed).',
    type: ApiErrorResponse,
  })
  async balance(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Param('id') id: string,
    @Body() request: OnlineBalanceRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OnlineOrderResponse> {
    if (
      request.method === OnlineBalanceMethod.PAYSTACK &&
      this.config.paystackKey === undefined
    ) {
      throw new ServiceUnavailableException(CARD_REFUNDS_UNAVAILABLE_MESSAGE);
    }

    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute<BalanceRecorded>({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.OK,
      work: (tx) => this.online.balance(tx, actor, id, request, ipAddress),
    });

    if (result.body.refundId === null) {
      response.status(result.status);

      return result.body.onlineOrder;
    }

    const sent = await this.refunds.send(
      result.body.refundId,
      actor,
      ipAddress,
    );

    if (sent === OnlineRefundStatus.REFUSED) {
      throw new BadGatewayException(REFUND_REFUSED_MESSAGE);
    }

    if (sent !== OnlineRefundStatus.SENT) {
      throw new ServiceUnavailableException(REFUND_UNCONFIRMED_MESSAGE);
    }

    response.status(result.status);

    return this.online.detail(id);
  }
}
