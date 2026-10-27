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
import { PushQueueService, type PushTopics } from '../push/push-queue.service';
import {
  ApproveWasteRequest,
  CreateWasteRequest,
  EditWasteRequest,
  RejectWasteRequest,
  WasteQuery,
  WasteStatusRequest,
} from './dto/waste.request';
import { WastePageResponse, WasteResponse } from './dto/waste.response';
import { WasteService } from './waste.service';

/** The roles that log waste, each at its own location (plan §6.2). */
const WASTE_ROLES = [
  StaffRole.KITCHEN,
  StaffRole.BARTENDER,
  StaffRole.CASHIER,
  StaffRole.STOREKEEPER,
] as const;

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
  description: '"Waste record not found."',
  type: ApiErrorResponse,
} as const;

const LIMITS_REFUSED = {
  status: 403,
  description:
    '"Your current staff role cannot perform this action.", "This ' +
    'write-off is above the Owner Approval Limit of ₦50,000. The Owner must ' +
    'approve it.", "This would take your approvals today to …, above the ' +
    'Daily Approval Limit of …. The Owner must approve it.", or "You cannot ' +
    'approve a waste entry you created. The Owner or another manager must ' +
    'approve it."',
  type: ApiErrorResponse,
} as const;

const STALE = '"This record changed. Refresh and try again."';

const ID_PARAM = { name: 'id', description: 'WasteEntry.id.' } as const;

/**
 * Waste (plan §5.4; card C5-4): losses logged at each location, written
 * off by managers within the Owner's limits.
 */
@ApiTags('Waste')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/waste')
export class WasteController {
  constructor(
    private readonly waste: WasteService,
    private readonly idempotency: IdempotencyService,
    private readonly push: PushQueueService,
  ) {}

  @Get()
  @Roles(...WASTE_ROLES)
  @ApiOperation({
    operationId: 'staffWaste',
    summary: 'Waste entries, newest first',
    description:
      'A Kitchen user reads the Kitchen’s, a Bartender or Cashier the ' +
      'Bar’s, the Storekeeper the Store’s; managers every location. ' +
      '`pendingCount` is the entries awaiting review among them.',
  })
  @ApiResponse({ status: 200, type: WastePageResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose a stock location.", "Choose Pending, History or All.", or a ' +
      'bad page or search.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  list(
    @CurrentStaff() actor: StaffPrincipal,
    @Query() query: WasteQuery,
  ): Promise<WastePageResponse> {
    return this.waste.list(actor, query);
  }

  @Post()
  @Roles(...WASTE_ROLES)
  @HttpCode(HttpStatus.CREATED)
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffWasteCreate',
    summary: 'Log waste (waste.create)',
    description:
      'Each role at its own location, managers at any. Pending until a ' +
      'manager approves it; no stock moves until then. Takes an ' +
      'Idempotency-Key, so a retry after a lost response does not log it ' +
      'twice.',
  })
  @ApiResponse({ status: 201, type: WasteResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose a stock location.", "Enter a whole quantity and a waste ' +
      'reason.", "Select a stock item for this location.", or a missing ' +
      'Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      '"Your current staff role cannot perform this action.", "Kitchen ' +
      'staff can log kitchen waste only.", "Bar and cashier staff can log ' +
      'bar waste only.", or "Store staff can log store waste only."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description: 'The Idempotency-Key was used for a different request.',
    type: ApiErrorResponse,
  })
  async create(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: CreateWasteRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WasteResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const pushes: PushTopics = [];
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.waste.create(tx, actor, request, ipAddress, pushes),
    });

    // After the commit (C10); a replay ran no work and pushes nothing.
    await this.push.dispatchTopics(pushes);
    response.status(result.status);

    return result.body;
  }

  @Put(':id')
  @Roles()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffWasteEdit',
    summary: 'Correct a waste record (waste.edit)',
    description:
      'Managers, with a reason; the new value is held to the Owner Approval ' +
      'Limit. On an approved entry the increase in value counts toward the ' +
      'editor’s Daily Approval Limit, a manager may not correct an entry ' +
      'they logged (the Owner may), and the old quantity returns to its ' +
      'location and the new one leaves.',
  })
  @ApiResponse({ status: 200, type: WasteResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose an item for this stock location.", "Enter a whole quantity ' +
      'and waste reason.", "An admin correction requires a reason.", or a ' +
      'bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      '"Your current staff role cannot perform this action.", "This ' +
      'write-off is above the Owner Approval Limit of …. The Owner must ' +
      'approve it.", the daily limit sentence, or "You cannot change an ' +
      'approved waste entry you created. The Owner or another manager must ' +
      'change it."',
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: `"Insufficient <location> stock for <item>.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  edit(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: EditWasteRequest,
    @Req() httpRequest: Request,
  ): Promise<WasteResponse> {
    return this.waste.edit(actor, id, request, clientAddressOf(httpRequest));
  }

  @Post(':id/approve')
  @Roles()
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffWasteApprove',
    summary: 'Approve a waste entry (waste.approve)',
    description:
      'Managers, within the Owner Approval Limit and the Daily Approval ' +
      'Limit, never their own; the Owner without limits. The quantity ' +
      'leaves its location once.',
  })
  @ApiResponse({ status: 200, type: WasteResponse })
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
    description: `"Only pending waste can be reviewed.", "Insufficient <location> stock for <item>.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  approve(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: ApproveWasteRequest,
    @Req() httpRequest: Request,
  ): Promise<WasteResponse> {
    return this.waste.approve(actor, id, request, clientAddressOf(httpRequest));
  }

  @Post(':id/reject')
  @Roles()
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffWasteReject',
    summary: 'Reject a waste entry (waste.reject)',
    description: 'Managers, their own entries included. No stock moves.',
  })
  @ApiResponse({ status: 200, type: WasteResponse })
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
    description: `"Only pending waste can be reviewed.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  reject(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: RejectWasteRequest,
    @Req() httpRequest: Request,
  ): Promise<WasteResponse> {
    return this.waste.reject(actor, id, request, clientAddressOf(httpRequest));
  }

  @Post(':id/status')
  @Roles()
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffWasteStatus',
    summary: 'Correct a waste entry’s status (waste.status)',
    description:
      'Managers, with a reason. To Approved is an approval: the limits and ' +
      'the own-record rule apply and the quantity leaves its location. ' +
      'Away from Approved, the quantity returns.',
  })
  @ApiResponse({ status: 200, type: WasteResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Select a waste record and valid status.", "An admin correction ' +
      'requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(LIMITS_REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description: `"Insufficient <location> stock for <item>.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  setStatus(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: WasteStatusRequest,
    @Req() httpRequest: Request,
  ): Promise<WasteResponse> {
    return this.waste.setStatus(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }
}
