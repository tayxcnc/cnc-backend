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
  CustomerWriteThrottle,
  PUSH_SUBSCRIPTION_LIMIT,
} from '../auth/auth-throttle';
import type { CustomerPrincipal } from '../auth/customer-principal';
import { CurrentCustomer } from '../auth/decorators/current-customer.decorator';
import { CncCustomerGuard } from '../auth/guards/cnc-customer.guard';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import {
  PushPublicKeyResponse,
  PushSubscribeRequest,
  PushUnsubscribeRequest,
} from './dto/push.dto';
import { PushSubscriptionsService } from './push-subscriptions.service';

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

const NOT_CONFIGURED = {
  status: 404,
  description: 'Push is not configured on this service.',
  type: ApiErrorResponse,
} as const;

const THROTTLED = {
  status: 429,
  description: 'Too many requests (per customer). The body says what to do.',
  type: ApiErrorResponse,
} as const;

/**
 * Web push for the customer's account app (C10): the key to subscribe
 * with, and binding or releasing this browser. Signed-in only (D10): the
 * control is shown only to a signed-in person, so no public surface is
 * added. The class guard runs before each method's throttler, so a
 * request without a valid token is refused uncounted.
 */
@ApiTags('Customer account')
@ApiBearerAuth()
@UseGuards(CncCustomerGuard)
@Controller('me/push')
export class CustomerPushController {
  constructor(private readonly subscriptions: PushSubscriptionsService) {}

  @Get('public-key')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'getMyPushKey',
    summary: 'The key this browser subscribes with',
    description:
      'CNC’s VAPID public key, the `applicationServerKey` for ' +
      '`pushManager.subscribe`. 404 "Notifications are not set up on ' +
      'this service yet." where push is not configured.',
  })
  @ApiResponse({ status: 200, type: PushPublicKeyResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse(NOT_CONFIGURED)
  publicKey(): PushPublicKeyResponse {
    return { publicKey: this.subscriptions.servedKey() };
  }

  @Post('subscriptions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ClientAddressThrottlerGuard)
  @CustomerWriteThrottle(PUSH_SUBSCRIPTION_LIMIT)
  @ApiOperation({
    operationId: 'saveMyPushSubscription',
    summary: 'Turn notifications on for this browser',
    description:
      'Stores the browser’s subscription for the signed-in customer. An ' +
      'endpoint another account holds moves only when the keys match; ' +
      'otherwise nothing is written. 409 when the subscription was made ' +
      'with a key that is no longer the service’s: subscribe again. 401 ' +
      'when the session behind the token has ended (signed out).',
  })
  @ApiResponse({ status: 204, description: 'Stored, or left as it was.' })
  @ApiResponse({
    status: 400,
    description: 'An endpoint off the push-service list, or bad keys.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse(NOT_CONFIGURED)
  @ApiResponse({
    status: 409,
    description: 'Made with another key: subscribe again.',
    type: ApiErrorResponse,
  })
  @ApiResponse(THROTTLED)
  async subscribe(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Body() body: PushSubscribeRequest,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<void> {
    await this.subscriptions.subscribe(
      'CUSTOMER',
      customer.id,
      body,
      userAgent,
    );
  }

  @Delete('subscriptions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ClientAddressThrottlerGuard)
  @CustomerWriteThrottle(PUSH_SUBSCRIPTION_LIMIT)
  @ApiOperation({
    operationId: 'deleteMyPushSubscription',
    summary: 'Turn notifications off for this browser',
    description:
      'Removes the endpoint if the signed-in customer holds it; anyone ' +
      'else’s is left alone. 204 either way.',
  })
  @ApiResponse({ status: 204, description: 'Removed, or never held.' })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse(THROTTLED)
  async unsubscribe(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Body() body: PushUnsubscribeRequest,
  ): Promise<void> {
    await this.subscriptions.unsubscribe(
      'CUSTOMER',
      customer.id,
      body.endpoint,
    );
  }
}
