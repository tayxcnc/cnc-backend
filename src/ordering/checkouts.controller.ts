import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AddressThrottle } from '../auth/auth-throttle';
import type { CustomerPrincipal } from '../auth/customer-principal';
import { MaybeCustomer } from '../auth/decorators/current-customer.decorator';
import { OptionalCustomerGuard } from '../auth/guards/optional-customer.guard';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { CncConfigService } from '../config/cnc.config';
import {
  IdempotencyKey,
  type IdempotencyRequest,
  IdempotentRoute,
} from '../idempotency/idempotency-key.decorator';
import { idempotencyScope } from '../idempotency/idempotency-scope';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ONLINE_PAYMENT_UNAVAILABLE_MESSAGE } from '../payments/payment-messages';
import { CheckoutsService, type CreatedCheckout } from './checkouts.service';
import {
  CheckoutCreatedResponse,
  CheckoutRequest,
  CheckoutStatusResponse,
} from './dto/checkout.dto';

/**
 * Checkouts per client address in fifteen minutes, in memory (A18). Each
 * one is a call to Paystack on CNC's account; a person retrying a declined
 * card a few times stays far below it, and the venue's Wi-Fi shares one
 * address among many guests.
 */
export const CHECKOUT_ADDRESS_LIMIT = 30;

/**
 * The web and app checkout (plan §5.1, §7.4; card C7-1). No sign-in is
 * needed; with a customer token the checkout is the app's and the
 * customer's. Checkout never creates a session (A15).
 */
@ApiTags('Public')
@Controller('checkouts')
export class CheckoutsController {
  constructor(
    private readonly checkouts: CheckoutsService,
    private readonly idempotency: IdempotencyService,
    private readonly config: CncConfigService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(OptionalCustomerGuard, ClientAddressThrottlerGuard)
  @AddressThrottle(CHECKOUT_ADDRESS_LIMIT)
  @IdempotentRoute()
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth()
  @ApiOperation({
    operationId: 'createCheckout',
    summary: 'Start paying for a web order',
    description:
      'Prices the cart from the menu (subtotal, VAT on it, the zone’s ' +
      'delivery fee; nothing added for Paystack, Q33), checks the address ' +
      'and the timing against `GET /ordering/slots`’ rules, stores a ' +
      'PENDING checkout and initializes a Paystack transaction for exactly ' +
      'its total. No order number is drawn until the payment is confirmed. ' +
      'Takes an Idempotency-Key: a retry answers the same reference and ' +
      'payment page. With a customer token the checkout is the app’s.',
  })
  @ApiResponse({ status: 201, type: CheckoutCreatedResponse })
  @ApiResponse({
    status: 400,
    description:
      'The website form’s sentences ("Your order is empty. Add dishes from ' +
      'the menu.", "Choose where we are delivering to.", "Add the street ' +
      'address.", "Add a nearby landmark so our rider can find you…", ' +
      '"Choose a time.", "Add your name.", "Enter a Nigerian phone number, ' +
      'for example 0803 123 4567.", "Add your email for the receipt.", ' +
      '"Check the email address."), a dish no longer available, or a ' +
      'missing Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse({ status: 401, description: 'A customer token that fails.' })
  @ApiResponse({ status: 403, description: 'A staff token.' })
  @ApiResponse({
    status: 409,
    description: 'An Idempotency-Key reused for a different request.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 429,
    description: '"Too many attempts. Wait a few minutes and try again."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 502,
    description:
      'Paystack refused to start the payment; the checkout is closed and a ' +
      'new one (a new key) starts again.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 503,
    description:
      'Paystack could not be reached (the same key tries again), or ' +
      'online payment is not configured.',
    type: ApiErrorResponse,
  })
  async create(
    @MaybeCustomer() customer: CustomerPrincipal | null,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: CheckoutRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CheckoutCreatedResponse> {
    if (this.config.paystackKey === undefined) {
      throw new ServiceUnavailableException(ONLINE_PAYMENT_UNAVAILABLE_MESSAGE);
    }

    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute<CreatedCheckout>({
      ...idempotency,
      scope:
        customer === null
          ? idempotencyScope.anonymous(ipAddress)
          : idempotencyScope.customer(customer.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.checkouts.create(tx, customer, request, ipAddress),
    });

    // After the commit, never inside it: a network call must not hold the
    // transaction, and Paystack's page is keyed by the checkout's own
    // reference, so a retry finds the page stored on the row.
    const payment = await this.checkouts.startPayment(result.body.reference);

    response.status(result.status);

    return { ...result.body, ...payment };
  }

  @Get(':reference')
  @Header('Cache-Control', 'no-store')
  @ApiParam({ name: 'reference', description: 'Checkout.reference.' })
  @ApiOperation({
    operationId: 'getCheckout',
    summary: 'A checkout’s state, for the confirmation page',
    description:
      'Answers to the reference alone (122 random bits): the status, the ' +
      'order number once paid, the name, fulfilment, address and timing ' +
      'as the page writes them, the lines, the sums and the card ' +
      '("Visa ending 4242"). Never the phone, email, note or account. ' +
      'Never cached.',
  })
  @ApiResponse({ status: 200, type: CheckoutStatusResponse })
  @ApiResponse({
    status: 404,
    description: '"We could not find that order."',
    type: ApiErrorResponse,
  })
  read(@Param('reference') reference: string): Promise<CheckoutStatusResponse> {
    return this.checkouts.read(reference);
  }
}
