import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { StaffRole } from '../../generated/cnc-client';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { DocketsService } from './dockets.service';
import { DocketListQuery } from './dto/docket.request';
import { DocketPageResponse, DocketResponse } from './dto/order.response';

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
 * Kitchen dockets by number (plan §5.4, Kitchen; card C4-4). The Kitchen
 * types the number from the paper docket; the Cashier and Waiter print
 * dockets. Dockets are Restaurant records, so a Bartender has no reason to
 * read one.
 */
@ApiTags('Kitchen')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Roles(StaffRole.KITCHEN, StaffRole.CASHIER, StaffRole.WAITER)
@Controller('staff/dockets')
export class DocketsController {
  constructor(private readonly dockets: DocketsService) {}

  @Get()
  @ApiOperation({
    operationId: 'staffDockets',
    summary: 'One day’s dockets',
    description:
      'The latest revision of each docket for a business date (today when ' +
      'absent), newest first; `channel=WEB` for the day’s web dockets.',
  })
  @ApiResponse({ status: 200, type: DocketPageResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad date, channel or page.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  list(@Query() query: DocketListQuery): Promise<DocketPageResponse> {
    return this.dockets.list(query);
  }

  @Get(':ref')
  @ApiParam({
    name: 'ref',
    description: 'The docket number as printed (`KOT-CNCR-000001`), any case.',
  })
  @ApiOperation({
    operationId: 'staffDocket',
    summary: 'A docket’s latest revision',
    description:
      'The revision the kitchen records against: its order, date, ' +
      'revision and dishes.',
  })
  @ApiResponse({ status: 200, type: DocketResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 404,
    description:
      '"Docket not found. Enter the kitchen docket number printed by ' +
      'Restaurant POS."',
    type: ApiErrorResponse,
  })
  byRef(@Param('ref') ref: string): Promise<DocketResponse> {
    return this.dockets.byRef(ref);
  }
}
