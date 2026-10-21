import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { PaginationQuery } from '../common/dto/pagination.query';
import { StaffNotificationsService } from './staff-notifications.service';

/** One bell item (plan §9.1). */
export class StaffNotificationResponse {
  @ApiProperty({ example: 'free:clx…:2026-10-21T18:00:00.000Z' }) id!: string;
  @ApiProperty({ example: 'Free Table Reminder' }) title!: string;
  @ApiProperty({
    example: 'Booth 1 · Ada seated 3 hours ago. Free it if they have left.',
  })
  detail!: string;
  @ApiProperty({
    example: 'reception',
    description:
      'The staff app page the item opens; always one the reader can open.',
  })
  page!: string;
  @ApiProperty({ example: 'Reception' }) category!: string;
}

/** `GET /staff/notifications`. */
export class StaffNotificationPageResponse {
  @ApiProperty({ type: StaffNotificationResponse, isArray: true })
  data!: StaffNotificationResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

/**
 * The staff bell (plan §9.1, computed on read, A20). Every signed-in
 * staff member may read it; each item is for the roles §9.1 names.
 */
@ApiTags('Shell')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/notifications')
export class StaffNotificationsController {
  constructor(private readonly notifications: StaffNotificationsService) {}

  @Get()
  @ApiOperation({
    operationId: 'staffNotifications',
    summary: 'The staff bell',
    description:
      'The reader’s pending items, computed now. Today it carries the Free ' +
      'Table Reminder (Reception and managers); card C8-2 adds the rest of ' +
      'plan §9.1.',
  })
  @ApiResponse({ status: 200, type: StaffNotificationPageResponse })
  @ApiResponse({
    status: 401,
    description: 'No bearer token, or one that fails verification.',
    type: ApiErrorResponse,
  })
  list(
    @CurrentStaff() actor: StaffPrincipal,
    @Query() query: PaginationQuery,
  ): Promise<StaffNotificationPageResponse> {
    return this.notifications.list(actor, query);
  }
}
