import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CustomerWriteThrottle,
  NOTIFICATIONS_READ_LIMIT,
} from '../auth/auth-throttle';
import type { CustomerPrincipal } from '../auth/customer-principal';
import { CurrentCustomer } from '../auth/decorators/current-customer.decorator';
import { CncCustomerGuard } from '../auth/guards/cnc-customer.guard';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { PaginationQuery } from '../common/dto/pagination.query';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { CustomerNotificationsService } from './customer-notifications.service';
import {
  CustomerNotificationPageResponse,
  NotificationsReadResponse,
} from './dto/customer-notification.dto';

const UNAUTHORISED = {
  status: 401,
  description: 'No valid customer token, or the account is gone or deleted.',
  type: ApiErrorResponse,
} as const;

const STAFF_TOKEN = {
  status: 403,
  description: 'A staff token.',
  type: ApiErrorResponse,
} as const;

/**
 * The customer's in-app list (plan §5.2, card C6-8). Personal data:
 * `Cache-Control: no-store`, as every `/me` answer.
 */
@ApiTags('Customer account')
@ApiBearerAuth()
@UseGuards(CncCustomerGuard)
@Controller('me/notifications')
export class CustomerNotificationsController {
  constructor(private readonly notifications: CustomerNotificationsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'listMyNotifications',
    summary: 'The customer’s notifications, newest first',
    description:
      'Bookings made, changed, cancelled and reminded, and the welcome. ' +
      'Each says whether it is unread; `unread` counts them all.',
  })
  @ApiResponse({ status: 200, type: CustomerNotificationPageResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  list(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Query() query: PaginationQuery,
  ): Promise<CustomerNotificationPageResponse> {
    return this.notifications.list(customer.id, query);
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientAddressThrottlerGuard)
  @CustomerWriteThrottle(NOTIFICATIONS_READ_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'markMyNotificationsRead',
    summary: 'Mark every notification read',
    description:
      'The account app’s "Mark All as Read". The instant is the server’s ' +
      'and never moves back.',
  })
  @ApiResponse({ status: 200, type: NotificationsReadResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse({
    status: 429,
    description: 'Too many requests (per customer). The body says what to do.',
    type: ApiErrorResponse,
  })
  markRead(
    @CurrentCustomer() customer: CustomerPrincipal,
  ): Promise<NotificationsReadResponse> {
    return this.notifications.markRead(customer.id);
  }
}
