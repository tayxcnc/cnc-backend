import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AddressThrottle } from '../auth/auth-throttle';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { PublicCache } from '../common/public-cache';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import {
  OrderingConfigResponse,
  OrderingSlotsQuery,
  OrderingSlotsResponse,
} from './dto/ordering.dto';
import { OrderingService } from './ordering.service';
import { CheckoutsService } from './checkouts.service';
import { QuoteRequest, QuoteResponse } from './dto/checkout.dto';

/**
 * Quotes per client address in fifteen minutes (C8-3). The order page asks
 * once each time a guest reaches the payment step, so a hundred and twenty
 * is four times the checkouts a single address may make
 * (`CHECKOUT_ADDRESS_LIMIT`), with room for the venue's Wi-Fi; a quote
 * reads the menu and the Bar's stock, so a script pricing carts in a loop
 * must stop somewhere.
 */
export const QUOTE_ADDRESS_LIMIT = 120;

/**
 * The order page's public reads (plan §5.1, C6-4). No sign-in. The config
 * is cached for a minute; the slots depend on the minute they are asked,
 * so they are never stored.
 */
@ApiTags('Public')
@Controller('ordering')
export class OrderingController {
  constructor(
    private readonly ordering: OrderingService,
    private readonly checkouts: CheckoutsService,
  ) {}

  @Get('config')
  @PublicCache()
  @ApiOperation({
    operationId: 'getOrderingConfig',
    summary: 'Prices and times the order page uses',
    description:
      'VAT, the two delivery zones with their fees and lead times, the ' +
      'pickup lead time, the slot grid and the last order slot. Public; ' +
      'cached for a minute.',
  })
  @ApiResponse({ status: 200, type: OrderingConfigResponse })
  config(): Promise<OrderingConfigResponse> {
    return this.ordering.config();
  }

  @Get('slots')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'getOrderingSlots',
    summary: 'When an order placed now can be received',
    description:
      'Whether "As soon as possible" is offered, and the scheduled times ' +
      'left today and tomorrow (Lagos time), for the fulfilment and zone ' +
      'given. Public; never cached.',
  })
  @ApiResponse({ status: 200, type: OrderingSlotsResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose delivery or pickup." or, for a delivery, "Choose where we ' +
      'are delivering to."',
    type: ApiErrorResponse,
  })
  slots(@Query() query: OrderingSlotsQuery): Promise<OrderingSlotsResponse> {
    return this.ordering.slots(query);
  }

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientAddressThrottlerGuard)
  @AddressThrottle(QUOTE_ADDRESS_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'quoteOrder',
    summary: 'The server’s prices for a cart',
    description:
      'Each line priced from the menu as it stands, the subtotal, VAT on ' +
      'it, the zone’s delivery fee (pickup is free) and the total (Q33: ' +
      'nothing added for Paystack). A drink the Bar may be short of is a ' +
      'warning, never a refusal. Public; a read, so never stored or cached.',
  })
  @ApiResponse({ status: 200, type: QuoteResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Your order is empty. Add dishes from the menu.", "Choose delivery ' +
      'or pickup.", "Choose where we are delivering to.", a dish no longer ' +
      'available, or a choice that is not one of the dish’s options.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 429,
    description:
      '"Too many attempts. Wait a few minutes and try again." More than ' +
      `${QUOTE_ADDRESS_LIMIT} quotes in fifteen minutes from one address; ` +
      'with `Retry-After`.',
    type: ApiErrorResponse,
  })
  quote(@Body() request: QuoteRequest): Promise<QuoteResponse> {
    return this.checkouts.quote(request);
  }
}
