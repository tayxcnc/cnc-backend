import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { ApprovalsService } from './approvals.service';
import { ApprovalsQuery } from './dto/approvals.request';
import { ApprovalsResponse } from './dto/approvals.response';

/**
 * Approvals (plan §5.4; card C5-8): the managers' read of what awaits a
 * decision. The decisions themselves are the purchase and waste routes.
 */
@ApiTags('Approvals')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @Roles()
  @ApiOperation({
    operationId: 'staffApprovals',
    summary: 'Requisitions and waste awaiting a decision, or decided',
    description:
      'Managers only. In the Pending view each record carries `awaiting`: ' +
      'whether it awaits the Owner (above the Owner Approval Limit) or a ' +
      'manager, the value it would be judged on, and whether the reader’s ' +
      'approval would pass now, with the exact sentence it would be ' +
      'refused with. `standing` is the reader’s limits and total today.',
  })
  @ApiResponse({ status: 200, type: ApprovalsResponse })
  @ApiResponse({
    status: 400,
    description: '"Choose Pending or History.", or a bad page or search.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'No bearer token, or one that fails verification.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description: '"Your current staff role cannot perform this action."',
    type: ApiErrorResponse,
  })
  read(
    @CurrentStaff() actor: StaffPrincipal,
    @Query() query: ApprovalsQuery,
  ): Promise<ApprovalsResponse> {
    return this.approvals.read(actor, query);
  }
}
