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
import {
  CreateStockItemRequest,
  StockAdjustRequest,
  StockCountRequest,
  StockIssueRequest,
  UpdateStockItemRequest,
} from './dto/stock.request';
import {
  StockAdjustResponse,
  StockBalancePageResponse,
  StockBalancesQuery,
  StockCountResponse,
  StockIssueResponse,
  StockItemResponse,
  StockMovementPageResponse,
  StockMovementsQuery,
} from './dto/stock.response';
import { StockService } from './stock.service';

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

const INSUFFICIENT = {
  status: 409,
  description:
    'A balance would go below zero ("Insufficient store stock for Rice."), ' +
    'or the Idempotency-Key was used for a different request.',
  type: ApiErrorResponse,
} as const;

/**
 * Stock & Requests' stock core (plan §5.4; card C4-2): balances, movements,
 * direct issue, stock count, Correct Balance and stock items. Requests are
 * C5's.
 */
@ApiTags('Stock & Requests')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/stock')
export class StockController {
  constructor(
    private readonly stock: StockService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('balances')
  @Roles(StaffRole.BARTENDER, StaffRole.KITCHEN, StaffRole.STOREKEEPER)
  @ApiOperation({
    operationId: 'staffStockBalances',
    summary: 'Balances at one location',
    description:
      'Every item the location holds, by name, with its balance, reorder ' +
      'level and Low Stock flag; at the Bar also the drinks on unsettled ' +
      'Bar bills. A Bartender reads the Bar only and a Kitchen user the ' +
      'Kitchen only; the Storekeeper and managers read any location.',
  })
  @ApiResponse({ status: 200, type: StockBalancePageResponse })
  @ApiResponse({
    status: 400,
    description: '"Choose a stock location.", or a bad page.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  balances(
    @CurrentStaff() actor: StaffPrincipal,
    @Query() query: StockBalancesQuery,
  ): Promise<StockBalancePageResponse> {
    return this.stock.balances(actor, query);
  }

  @Get('movements')
  @Roles(StaffRole.STOREKEEPER)
  @ApiOperation({
    operationId: 'staffStockMovements',
    summary: 'Stock movements, newest first',
    description: 'Managers and the Storekeeper (plan §6.1).',
  })
  @ApiResponse({ status: 200, type: StockMovementPageResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad filter or page.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  movements(
    @Query() query: StockMovementsQuery,
  ): Promise<StockMovementPageResponse> {
    return this.stock.movements(query);
  }

  @Post('items')
  @Roles()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    operationId: 'staffStockItemCreate',
    summary: 'Add a stock item (stockitem.create)',
    description:
      'Managers only. A Kitchen item, at zero everywhere until stock is ' +
      'counted, issued or received. Bar items are made with their menu ' +
      'item. No Idempotency-Key: a retry is refused on the name.',
  })
  @ApiResponse({ status: 201, type: StockItemResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter an item name and units." or "Enter a whole conversion above ' +
      'zero and a non-negative minimum."',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 409,
    description: '"This stock item already exists."',
    type: ApiErrorResponse,
  })
  createItem(
    @CurrentStaff() actor: StaffPrincipal,
    @Body() request: CreateStockItemRequest,
    @Req() httpRequest: Request,
  ): Promise<StockItemResponse> {
    return this.stock.createItem(actor, request, clientAddressOf(httpRequest));
  }

  @Patch('items/:id')
  @Roles()
  @ApiParam({ name: 'id', description: 'StockItem.id.' })
  @ApiOperation({
    operationId: 'staffStockItemUpdate',
    summary: 'Change a stock item’s units (stockitem.save)',
    description:
      'Managers only, with a reason. Bought As, Used As, How Many in One ' +
      'and Reorder Level. Balances are not rescaled (D40).',
  })
  @ApiResponse({ status: 200, type: StockItemResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter units, a whole conversion above zero and a non-negative ' +
      'minimum.", "An admin correction requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 404,
    description: '"Stock item not found."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description: '"This record changed. Refresh and try again."',
    type: ApiErrorResponse,
  })
  saveItem(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: UpdateStockItemRequest,
    @Req() httpRequest: Request,
  ): Promise<StockItemResponse> {
    return this.stock.saveItem(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Post('issues')
  @Roles(StaffRole.STOREKEEPER)
  @HttpCode(HttpStatus.CREATED)
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffStockIssue',
    summary: 'Issue stock directly (stock.issue)',
    description:
      'The Storekeeper (and managers). Whole packs leave the Store; the ' +
      'Kitchen or the Bar receives packs × How Many in One. Takes an ' +
      'Idempotency-Key, so a retry after a lost response does not issue ' +
      'twice.',
  })
  @ApiResponse({ status: 201, type: StockIssueResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose Kitchen or Bar.", "Select an item for this stock location.", ' +
      '"Enter a whole number above zero.", or a missing Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse(INSUFFICIENT)
  async issue(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: StockIssueRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockIssueResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.stock.issue(tx, actor, request, ipAddress),
    });

    response.status(result.status);

    return result.body;
  }

  @Post('counts')
  @HttpCode(HttpStatus.CREATED)
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffStockCount',
    summary: 'Record a stock count (stock.count)',
    description:
      'The Storekeeper counts the Store; managers count any location. Only ' +
      'the differences are written. By Q28’s default the differences are ' +
      'valued as waste is valued (a Store count’s packs × How Many in ' +
      'One): above the Owner Approval Limit only the Owner may record ' +
      'them, and they count toward the Daily Approval Limit. Takes an ' +
      'Idempotency-Key, so a retry after a lost response replays the first ' +
      'answer instead of undoing stock moved in between.',
  })
  @ApiResponse({ status: 201, type: StockCountResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose a stock location.", "Enter at least one counted figure.", ' +
      '"Counted figures must be whole numbers of zero or more.", ' +
      '"Combine duplicate items into one quantity.", "Choose an item for ' +
      'this location.", or a missing Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      '"Only the storekeeper counts the store. Managers count any ' +
      'location.", or "This stock count is above the Owner Approval Limit ' +
      'of ₦50,000. The Owner must approve it." and the daily limit sentence.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description: '"Stock item not found."',
    type: ApiErrorResponse,
  })
  async count(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: StockCountRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockCountResponse> {
    this.stock.assertMayCount(actor, request.location);

    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.stock.count(tx, actor, request, ipAddress),
    });

    response.status(result.status);

    return result.body;
  }

  @Post('adjustments')
  @HttpCode(HttpStatus.CREATED)
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffStockAdjust',
    summary: 'Correct a balance (stock.adjust)',
    description:
      'The Owner only, with a reason: add or remove a whole number at one ' +
      'location. Takes an Idempotency-Key, so a retry does not correct ' +
      'twice.',
  })
  @ApiResponse({ status: 201, type: StockAdjustResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose a stock location.", "Choose an item for this location.", ' +
      '"Choose Add or Remove.", "Enter a whole number above zero.", "An ' +
      'admin correction requires a reason.", or a missing Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description: '"Only the Owner can correct a stock balance."',
    type: ApiErrorResponse,
  })
  @ApiResponse(INSUFFICIENT)
  async adjust(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: StockAdjustRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StockAdjustResponse> {
    this.stock.assertMayAdjust(actor);

    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.stock.adjust(tx, actor, request, ipAddress),
    });

    response.status(result.status);

    return result.body;
  }
}
