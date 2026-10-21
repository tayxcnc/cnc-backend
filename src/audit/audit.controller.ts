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
import { AuditQueryService } from './audit-query.service';
import { AuditPageResponse } from './dto/audit-entry.response';
import { AuditListQuery } from './dto/audit-list.query';

/**
 * The activity history, read (plan §5.4: Activity History, and every
 * screen's record history through `?ref=`).
 *
 * No `@Roles`: every active staff member may call it, and
 * `AuditQueryService` applies plan §4.8's rules to what they ask for.
 */
@ApiTags('Activity History')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/audit')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  @ApiOperation({
    operationId: 'auditList',
    summary: 'The activity history, in plain sentences',
    description:
      'Newest first, paginated. `from` and `to` are WAT calendar dates, ' +
      'both inclusive. Each entry says what changed in sentences; the raw ' +
      'before and after are never returned. The Owner sees every entry; a ' +
      "Manager every entry except another Manager's. Other roles may ask " +
      'only for one record they can read (`ref`), and Reception also for ' +
      '`action=maintenance.save`.',
  })
  @ApiResponse({ status: 200, type: AuditPageResponse })
  @ApiResponse({
    status: 400,
    description: 'An impossible date, `to` before `from`, or a bad page.',
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
      'A query this role may not make, or a record it may not read ("Your ' +
      'current staff role cannot perform this action."); a customer token; ' +
      'a deactivated account; or a pending password change.',
    type: ApiErrorResponse,
  })
  list(
    @CurrentStaff() viewer: StaffPrincipal,
    @Query() query: AuditListQuery,
  ): Promise<AuditPageResponse> {
    return this.audit.list(viewer, query);
  }
}
