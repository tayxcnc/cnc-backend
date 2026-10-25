import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { OverviewQuery } from './dto/overview.query';
import { OverviewResponse } from './dto/overview.response';
import { OverviewService } from './overview.service';

/**
 * The Overview screen (plan §5.3, §6.1, §10; card C8-1). Open to every
 * active staff member, as the Overview page is (`canAccess`): the role
 * decides what comes back, not whether anything does.
 */
@ApiTags('Overview')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get('overview')
  @ApiOperation({
    operationId: 'staffOverview',
    summary: 'The overview',
    description:
      'Managers and the Owner: the widgets their saved layout shows, over ' +
      '`from`…`to` (Lagos business dates, today when absent, at most 366 ' +
      'days; the Sales Trend is hourly for one day, daily up to 62 days, ' +
      'monthly beyond); hidden widgets are null. Every other role: the ' +
      'staff overview for today, with its role’s row filters. Polled every ' +
      '60 seconds.',
  })
  @ApiResponse({ status: 200, type: OverviewResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad date, or a range over 366 days.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'No bearer token, or one that fails verification.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description:
      'A customer token, a deactivated account, or a pending password change.',
    type: ApiErrorResponse,
  })
  read(
    @CurrentStaff() actor: StaffPrincipal,
    @Query() query: OverviewQuery,
  ): Promise<OverviewResponse> {
    return this.overview.read(actor, query);
  }
}
