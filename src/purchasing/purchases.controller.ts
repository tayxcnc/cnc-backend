import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
  ApprovePurchaseRequest,
  ArchivePurchaseRequest,
  CreatePurchaseRequest,
  EditPurchaseRequest,
  PurchasesQuery,
  PurchaseStatusRequest,
  ReceivePurchaseRequest,
  RejectPurchaseRequest,
} from './dto/purchases.request';
import {
  PurchasePageResponse,
  PurchaseReceiveResponse,
  PurchaseResponse,
} from './dto/purchases.response';
import { PurchasesService } from './purchases.service';

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
  description: '"Purchase not found."',
  type: ApiErrorResponse,
} as const;

const LIMITS_REFUSED = {
  status: 403,
  description:
    '"Your current staff role cannot perform this action.", "This purchase ' +
    'is above the Owner Approval Limit of ₦50,000. The Owner must approve ' +
    'it.", "This would take your approvals today to …, above the Daily ' +
    'Approval Limit of …. The Owner must approve it.", or "You cannot ' +
    'approve a purchase you created. The Owner or another manager must ' +
    'approve it."',
  type: ApiErrorResponse,
} as const;

const STALE = '"This record changed. Refresh and try again."';

const ID_PARAM = { name: 'id', description: 'Purchase.id.' } as const;

/**
 * Purchasing (plan §5.4; card C5-3): requisitions raised by the
 * Storekeeper, decided by managers within the Owner's limits, and received
 * into the Store.
 */
@ApiTags('Purchasing')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/purchases')
export class PurchasesController {
  constructor(
    private readonly purchases: PurchasesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Roles(StaffRole.STOREKEEPER)
  @ApiOperation({
    operationId: 'staffPurchases',
    summary: 'Purchase requisitions, newest first',
    description:
      'The Storekeeper and managers. `counts` holds the screen’s three ' +
      'figures over every requisition.',
  })
  @ApiResponse({ status: 200, type: PurchasePageResponse })
  @ApiResponse({
    status: 400,
    description: '"Choose Active or History.", or a bad page or search.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  list(@Query() query: PurchasesQuery): Promise<PurchasePageResponse> {
    return this.purchases.list(query);
  }

  @Get(':id')
  @Roles(StaffRole.STOREKEEPER)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffPurchase',
    summary: 'One purchase requisition, with its lines',
  })
  @ApiResponse({ status: 200, type: PurchaseResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(NOT_FOUND)
  get(@Param('id') id: string): Promise<PurchaseResponse> {
    return this.purchases.get(id);
  }

  @Post()
  @Roles(StaffRole.STOREKEEPER)
  @HttpCode(HttpStatus.CREATED)
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffPurchaseCreate',
    summary: 'Raise a purchase requisition (purchase.create)',
    description:
      'The Storekeeper and managers. Opens "Review purchase …" for a ' +
      'manager. Takes an Idempotency-Key, so a retry after a lost response ' +
      'does not raise it twice.',
  })
  @ApiResponse({ status: 201, type: PurchaseResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Add at least one item.", "Combine duplicate items into one ' +
      'quantity.", "Quantities must be whole numbers above zero.", ' +
      '"Choose an active vendor for every line.", "Choose a stock item and ' +
      'positive unit cost.", or a missing Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 409,
    description: 'The Idempotency-Key was used for a different request.',
    type: ApiErrorResponse,
  })
  async create(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: CreatePurchaseRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PurchaseResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.purchases.create(tx, actor, request, ipAddress),
    });

    response.status(result.status);

    return result.body;
  }

  @Put(':id')
  @Roles()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffPurchaseEdit',
    summary: 'Correct a requisition (purchase.edit)',
    description:
      'Managers, with a reason. The old and new totals are held to the ' +
      'Owner Approval Limit. On a requisition with received goods the Store ' +
      'moves by the difference.',
  })
  @ApiResponse({ status: 200, type: PurchaseResponse })
  @ApiResponse({
    status: 400,
    description:
      'The list sentences, "Choose an item and a positive unit cost.", ' +
      '"Choose an active vendor for every line.", "An admin correction ' +
      'requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      '"Your current staff role cannot perform this action.", or "This ' +
      'purchase is above the Owner Approval Limit of …. The Owner must ' +
      'approve it."',
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: `"Select an active purchase record.", "Insufficient store stock for <item>.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  edit(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: EditPurchaseRequest,
    @Req() httpRequest: Request,
  ): Promise<PurchaseResponse> {
    return this.purchases.edit(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/approve')
  @Roles()
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffPurchaseApprove',
    summary: 'Approve a requisition (purchase.approve)',
    description:
      'Managers, within the Owner Approval Limit and the Daily Approval ' +
      'Limit, never their own; the Owner without limits. Closes the review ' +
      'task and opens "Receive goods for …" for the Storekeeper.',
  })
  @ApiResponse({ status: 200, type: PurchaseResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(LIMITS_REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: `"Only active pending requisitions can be reviewed.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  approve(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: ApprovePurchaseRequest,
    @Req() httpRequest: Request,
  ): Promise<PurchaseResponse> {
    return this.purchases.approve(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/reject')
  @Roles()
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffPurchaseReject',
    summary: 'Reject a requisition (purchase.reject)',
    description:
      'Managers, their own requisitions included. Closes the review task.',
  })
  @ApiResponse({ status: 200, type: PurchaseResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad version or reason.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: `"Only active pending requisitions can be reviewed.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  reject(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: RejectPurchaseRequest,
    @Req() httpRequest: Request,
  ): Promise<PurchaseResponse> {
    return this.purchases.reject(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/status')
  @Roles()
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffPurchaseStatus',
    summary: 'Correct a requisition’s status (purchase.status)',
    description:
      'Managers, with a reason, on a requisition neither archived nor ' +
      'received. To Approved is an approval: the limits and the own-record ' +
      'rule apply, and the receive task opens (plan §17, R1).',
  })
  @ApiResponse({ status: 200, type: PurchaseResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Use Receive goods to record stock receipt.", "An admin correction ' +
      'requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(LIMITS_REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: `"Received or archived purchases cannot return to approval.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  setStatus(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: PurchaseStatusRequest,
    @Req() httpRequest: Request,
  ): Promise<PurchaseResponse> {
    return this.purchases.setStatus(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/archive')
  @Roles()
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffPurchaseArchive',
    summary: 'Remove a requisition from active work (purchase.archive)',
    description:
      'Managers, with a reason. Cancelled too when nothing was received; ' +
      'received goods stay in the Store. Its open tasks close (plan §17, R1).',
  })
  @ApiResponse({ status: 200, type: PurchaseResponse })
  @ApiResponse({
    status: 400,
    description: '"An admin correction requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: `"Purchase not found or already archived.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  archive(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: ArchivePurchaseRequest,
    @Req() httpRequest: Request,
  ): Promise<PurchaseResponse> {
    return this.purchases.archive(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/receive')
  @Roles(StaffRole.STOREKEEPER)
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffPurchaseReceive',
    summary: 'Receive goods into the Store (purchase.receive)',
    description:
      'The Storekeeper and managers, all at once. Store +packs for every ' +
      'line, the requisition Fulfilled, its open tasks closed. No ' +
      'Idempotency-Key: a retry names a version the first attempt moved.',
  })
  @ApiResponse({ status: 200, type: PurchaseReceiveResponse })
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
    description: `"Receive only approved requisitions.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  receive(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: ReceivePurchaseRequest,
    @Req() httpRequest: Request,
  ): Promise<PurchaseReceiveResponse> {
    return this.purchases.receive(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }
}
