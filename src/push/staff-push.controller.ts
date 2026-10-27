import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  STAFF_PUSH_SUBSCRIPTION_LIMIT,
  StaffWriteThrottle,
} from '../auth/auth-throttle';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import {
  PushSubscribeRequest,
  PushUnsubscribeRequest,
  StaffPushPublicKeyResponse,
} from './dto/push.dto';
import { staffPushEventsFor } from './push-catalogue';
import { PushSubscriptionsService } from './push-subscriptions.service';

const UNAUTHORISED = {
  status: 401,
  description: 'No valid staff token, or the account is gone.',
  type: ApiErrorResponse,
} as const;

const REFUSED = {
  status: 403,
  description:
    'A customer token, an inactive account, or a password that must be ' +
    'changed first.',
  type: ApiErrorResponse,
} as const;

const NOT_CONFIGURED = {
  status: 404,
  description: 'Push is not configured on this service.',
  type: ApiErrorResponse,
} as const;

const THROTTLED = {
  status: 429,
  description:
    'Too many requests (per staff member). The body says what to do.',
  type: ApiErrorResponse,
} as const;

/**
 * Web push for the staff app (C10): the key to subscribe with and the
 * events the reader's role receives, and binding or releasing this device.
 * Every role may call it; which events ring is the catalogue's audience
 * (D8), read from the role on the account now (A14), never the token. The
 * class guard runs before each method's throttler, so a request without a
 * valid token is refused uncounted.
 */
@ApiTags('Shell')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/push')
export class StaffPushController {
  constructor(private readonly subscriptions: PushSubscriptionsService) {}

  @Get('public-key')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'getStaffPushKey',
    summary: 'The key this device subscribes with, and what it would ring for',
    description:
      'CNC’s VAPID public key, and the push events the reader’s role ' +
      'receives (none for Waiter and Bartender). 404 "Notifications are ' +
      'not set up on this service yet." where push is not configured.',
  })
  @ApiResponse({ status: 200, type: StaffPushPublicKeyResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  @ApiResponse(NOT_CONFIGURED)
  publicKey(@CurrentStaff() staff: StaffPrincipal): StaffPushPublicKeyResponse {
    return {
      publicKey: this.subscriptions.servedKey(),
      events: staffPushEventsFor(staff.role),
    };
  }

  @Post('subscriptions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ClientAddressThrottlerGuard)
  @StaffWriteThrottle(STAFF_PUSH_SUBSCRIPTION_LIMIT)
  @ApiOperation({
    operationId: 'saveStaffPushSubscription',
    summary: 'Turn notifications on for this device',
    description:
      'Stores the device’s subscription for the signed-in staff member. ' +
      'An endpoint another person holds moves only when the keys match ' +
      '(a shared tablet); otherwise nothing is written. 409 when the ' +
      'subscription was made with a key that is no longer the service’s: ' +
      'subscribe again. 401 when the session behind the token has ended ' +
      '(signed out, a password, role or status change).',
  })
  @ApiResponse({ status: 204, description: 'Stored, or left as it was.' })
  @ApiResponse({
    status: 400,
    description: 'An endpoint off the push-service list, or bad keys.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  @ApiResponse(NOT_CONFIGURED)
  @ApiResponse({
    status: 409,
    description: 'Made with another key: subscribe again.',
    type: ApiErrorResponse,
  })
  @ApiResponse(THROTTLED)
  async subscribe(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: PushSubscribeRequest,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<void> {
    await this.subscriptions.subscribe('STAFF', staff.id, body, userAgent);
  }

  @Delete('subscriptions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ClientAddressThrottlerGuard)
  @StaffWriteThrottle(STAFF_PUSH_SUBSCRIPTION_LIMIT)
  @ApiOperation({
    operationId: 'deleteStaffPushSubscription',
    summary: 'Turn notifications off for this device',
    description:
      'Removes the endpoint if the signed-in staff member holds it; anyone ' +
      'else’s is left alone. 204 either way.',
  })
  @ApiResponse({ status: 204, description: 'Removed, or never held.' })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  @ApiResponse(THROTTLED)
  async unsubscribe(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: PushUnsubscribeRequest,
  ): Promise<void> {
    await this.subscriptions.unsubscribe('STAFF', staff.id, body.endpoint);
  }
}
