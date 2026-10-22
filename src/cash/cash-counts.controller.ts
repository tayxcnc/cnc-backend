import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
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
import { CashCountsService } from './cash-counts.service';
import {
  CashCountResponse,
  CashReportQuery,
  CashReportResponse,
  CreateCashCountRequest,
} from './dto/cash-count.dto';

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

/**
 * Reports → Cash Reconciliation (plan §5.4, §6.2; card C4-8): the Cashier
 * and managers record a drawer count and read the counts. The report sits
 * under `staff/reports` with C8's others.
 */
@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Roles(StaffRole.CASHIER)
@Controller('staff')
export class CashCountsController {
  constructor(
    private readonly cash: CashCountsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('cash-counts')
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffCashCount',
    summary: 'Record a cash count (cash.count)',
    description:
      'The cash physically counted for a business date, compared with the ' +
      'date’s non-reversed cash payments. Several counts per date are ' +
      'allowed. Takes an Idempotency-Key: a retry replays the first count.',
  })
  @ApiResponse({ status: 201, type: CashCountResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter a valid cash count.", "Enter a valid reconciliation date.", ' +
      '"Cannot reconcile a future date.", or a missing Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 409,
    description: 'The Idempotency-Key was used for a different request.',
    type: ApiErrorResponse,
  })
  async count(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: CreateCashCountRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CashCountResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.cash.count(tx, actor, request, ipAddress),
    });

    response.status(result.status);

    return result.body;
  }

  @Get('reports/cash')
  @ApiOperation({
    operationId: 'staffReportCash',
    summary: 'Cash Reconciliation',
    description:
      'The counts recorded for business dates in the range (today when ' +
      'absent), in the order recorded, with the cash taken in the range ' +
      'and the latest count’s difference.',
  })
  @ApiResponse({ status: 200, type: CashReportResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad date, a range over 366 days, or a bad page.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  report(@Query() query: CashReportQuery): Promise<CashReportResponse> {
    return this.cash.report(query);
  }
}
