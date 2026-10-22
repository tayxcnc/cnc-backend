import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { KitchenCrosscheckQuery } from './dto/kitchen.request';
import { CrosscheckPageResponse } from './dto/kitchen.response';
import { KitchenCrosscheckService } from './kitchen-crosscheck.service';

/**
 * Reports → Kitchen Crosscheck (plan §5.4, §7.10, §10; card C4-6), managers
 * only (the Cashier's reports are payments, cash and transfers). Built here
 * with the kitchen entries it reads; C8's other reports join it under
 * `staff/reports`.
 */
@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Roles()
@Controller('staff/reports')
export class KitchenReportsController {
  constructor(private readonly crosscheck: KitchenCrosscheckService) {}

  @Get('kitchen-crosscheck')
  @ApiOperation({
    operationId: 'staffReportKitchenCrosscheck',
    summary: 'Kitchen Crosscheck',
    description:
      'Each docket in the business-date range (today when absent), at its ' +
      'latest revision, compared with the kitchen’s entry and the dishes’ ' +
      'comparison rules: MATCHED, MISSING_KITCHEN_ENTRY, ' +
      'REFERENCE_MISMATCH, REVISION_MISMATCH, MAPPING_REQUIRED, ' +
      'QUANTITY_MISMATCH; then UNMATCHED_KITCHEN_ENTRY for an entry no ' +
      'docket explains. A dish without a rule is flagged, never passed.',
  })
  @ApiResponse({ status: 200, type: CrosscheckPageResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad date, a range over 366 days, or a bad page.',
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
  report(
    @Query() query: KitchenCrosscheckQuery,
  ): Promise<CrosscheckPageResponse> {
    return this.crosscheck.report(query);
  }
}
