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
  CreateStockRequestRequest,
  IssueStockRequestRequest,
  RejectStockRequestRequest,
  StockRequestsQuery,
} from './dto/stock-requests.request';
import {
  StockRequestIssueResponse,
  StockRequestPageResponse,
  StockRequestResponse,
} from './dto/stock-requests.response';
import { StockRequestsService } from './stock-requests.service';

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
  description: '"Stock request not found."',
  type: ApiErrorResponse,
} as const;

const ID_PARAM = { name: 'id', description: 'StockRequest.id.' } as const;

/**
 * Stock & Requests' requests (plan §5.4; card C5-2): the Kitchen and the
 * Bar ask the Store for whole packs, and the Storekeeper issues or
 * declines them.
 */
@ApiTags('Stock & Requests')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/stock/requests')
export class StockRequestsController {
  constructor(
    private readonly requests: StockRequestsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Roles(StaffRole.BARTENDER, StaffRole.KITCHEN, StaffRole.STOREKEEPER)
  @ApiOperation({
    operationId: 'staffStockRequests',
    summary: 'Stock requests, newest first',
    description:
      'A Kitchen user reads the Kitchen’s requests and a Bartender the ' +
      'Bar’s; the Storekeeper and managers read both, or the location ' +
      'asked for. `openCount` is the Open Requests figure.',
  })
  @ApiResponse({ status: 200, type: StockRequestPageResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose Kitchen or Bar.", "Choose a request status.", or a bad page.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  list(
    @CurrentStaff() actor: StaffPrincipal,
    @Query() query: StockRequestsQuery,
  ): Promise<StockRequestPageResponse> {
    return this.requests.list(actor, query);
  }

  @Post()
  @Roles(StaffRole.KITCHEN, StaffRole.BARTENDER, StaffRole.CASHIER)
  @HttpCode(HttpStatus.CREATED)
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffStockRequestCreate',
    summary: 'Request stock from the Store (request.create)',
    description:
      'The Kitchen for the Kitchen; a Bartender or a Cashier for the Bar; ' +
      'managers for either. Whole packs of an item the location holds. ' +
      'Takes an Idempotency-Key, so a retry after a lost response does not ' +
      'ask twice.',
  })
  @ApiResponse({ status: 201, type: StockRequestResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose Kitchen or Bar.", "Enter a whole quantity above zero.", ' +
      '"Select an item for this stock location.", or a missing ' +
      'Idempotency-Key.',
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
    @Body() request: CreateStockRequestRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockRequestResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.requests.create(tx, actor, request, ipAddress),
    });

    response.status(result.status);

    return result.body;
  }

  @Post(':id/issue')
  @Roles(StaffRole.STOREKEEPER)
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffStockRequestIssue',
    summary: 'Issue stock against a request (request.issue)',
    description:
      'The Storekeeper (and managers), never for a request they raised ' +
      'themselves; the Owner is exempt. Whole packs leave the Store and ' +
      'the request’s location receives packs × How Many in One. No ' +
      'Idempotency-Key: a retry names a version the first attempt moved.',
  })
  @ApiResponse({ status: 200, type: StockRequestIssueResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter a whole number of <pack>s within the remaining request.", or ' +
      'a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      '"Your current staff role cannot perform this action.", or "You ' +
      'cannot approve a stock request you created. The Owner or another ' +
      'manager must approve it."',
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"This request is no longer open.", "Insufficient store stock for ' +
      '<item>.", or "This record changed. Refresh and try again."',
    type: ApiErrorResponse,
  })
  issue(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: IssueStockRequestRequest,
    @Req() httpRequest: Request,
  ): Promise<StockRequestIssueResponse> {
    return this.requests.issue(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/reject')
  @Roles(StaffRole.STOREKEEPER)
  @HttpCode(HttpStatus.OK)
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffStockRequestReject',
    summary: 'Decline a stock request (request.reject)',
    description:
      'The Storekeeper (and managers), with a reason. Packs already sent ' +
      'stay sent; no stock moves.',
  })
  @ApiResponse({ status: 200, type: StockRequestResponse })
  @ApiResponse({
    status: 400,
    description: '"Enter a rejection reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(NOT_FOUND)
  @ApiResponse({
    status: 409,
    description:
      '"This request is no longer open.", or "This record changed. Refresh ' +
      'and try again."',
    type: ApiErrorResponse,
  })
  reject(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: RejectStockRequestRequest,
    @Req() httpRequest: Request,
  ): Promise<StockRequestResponse> {
    return this.requests.reject(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }
}
