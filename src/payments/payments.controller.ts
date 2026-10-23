import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AddressThrottle } from '../auth/auth-throttle';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { CncConfigService } from '../config/cnc.config';
import { WebhookAckResponse } from './dto/webhook-ack.response';
import {
  INVALID_SIGNATURE_MESSAGE,
  ONLINE_PAYMENT_UNAVAILABLE_MESSAGE,
} from './payment-messages';
import { PaymentEventService } from './payment-event.service';
import { asEnvelope, referenceOf } from './paystack-events';
import {
  PAYSTACK_SIGNATURE_HEADER,
  deliveryId,
  isValidPaystackSignature,
} from './webhook-signature';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * Deliveries per client address per minute: a ceiling an order of
 * magnitude above any burst Paystack has reason to send (TAY's H-2), not a
 * budget, because Paystack retries a 429 like any non-2xx.
 */
export const WEBHOOK_DELIVERY_LIMIT = 120;
export const WEBHOOK_DELIVERY_WINDOW_MS = 60 * 1000;

/**
 * Paystack's webhook receiver (plan §5.1, §7.4 step 3, card C7-2), copied
 * from TAY's `PaymentsController`.
 *
 * Public: Paystack posts with no token. **The signature is the
 * authentication**: HMAC-SHA512 of the raw body under CNC's own secret key
 * (`rawBody: true` in bootstrap keeps the bytes). The handler parses the
 * verified bytes itself rather than taking a `@Body()`: only those bytes
 * were signed, and the ValidationPipe would refuse Paystack's fields.
 *
 * A signed delivery is recorded in `PaymentEvent` (its body's SHA-256
 * unique) and acknowledged at once; the work runs after the answer
 * (`WebhookDispatcherService`). A replay of the same bytes finds the row
 * and changes nothing. A failure to record is a 500, so Paystack retries a
 * delivery CNC has no record of.
 */
@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly config: CncConfigService,
    private readonly events: PaymentEventService,
    private readonly dispatcher: WebhookDispatcherService,
  ) {}

  @Post('webhook')
  @UseGuards(ClientAddressThrottlerGuard)
  @AddressThrottle(WEBHOOK_DELIVERY_LIMIT, WEBHOOK_DELIVERY_WINDOW_MS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'paystackWebhook',
    summary: 'Receive a Paystack event',
    description:
      'Called by Paystack, not by any client. Authenticated by the ' +
      '`x-paystack-signature` header (HMAC-SHA512 of the raw body under ' +
      'CNC’s secret key) and nothing else. A signed delivery is recorded ' +
      'and acknowledged; `charge.success` is then checked against ' +
      'Paystack’s verify and its checkout’s exact amount in NGN: a match ' +
      'pays the checkout, a mismatch holds it as NEEDS_ATTENTION and ' +
      'creates nothing. A repeated delivery changes nothing.',
  })
  @ApiBody({
    description:
      'Paystack’s envelope, `{ "event": "charge.success", "data": { … } }`; ' +
      'Paystack’s contract, not validated against a schema.',
    schema: {
      type: 'object',
      required: ['event', 'data'],
      properties: {
        event: { type: 'string', example: 'charge.success' },
        data: { type: 'object' },
      },
    },
  })
  @ApiResponse({ status: 200, type: WebhookAckResponse })
  @ApiResponse({
    status: 401,
    description: '"Invalid webhook signature." Nothing is recorded.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'More than 120 deliveries a minute from one address.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 503,
    description:
      'CNC’s Paystack key is not set (or is the placeholder): no delivery ' +
      'can be trusted, so none is accepted.',
    type: ApiErrorResponse,
  })
  async webhook(
    @Req() request: RawBodyRequest<Request>,
  ): Promise<WebhookAckResponse> {
    const key = this.config.paystackKey;

    if (key === undefined) {
      throw new ServiceUnavailableException(ONLINE_PAYMENT_UNAVAILABLE_MESSAGE);
    }

    const rawBody = request.rawBody;

    if (
      !isValidPaystackSignature(
        rawBody,
        request.headers[PAYSTACK_SIGNATURE_HEADER],
        key,
      )
    ) {
      // Nothing from the unverified body reaches the log.
      this.logger.warn(
        'Rejected a webhook delivery with an invalid signature.',
      );
      throw new UnauthorizedException(INVALID_SIGNATURE_MESSAGE);
    }

    const verified = rawBody as Buffer;
    const envelope = asEnvelope(parse(verified));

    if (envelope === undefined) {
      this.logger.warn('A correctly signed delivery carried no event.');
      return { received: true };
    }

    const recorded = await this.events.record(
      deliveryId(verified),
      envelope.event,
      referenceOf(envelope.data),
    );

    if (recorded.isNew) {
      this.dispatcher.dispatchInBackground(envelope, recorded.id);
    }

    return { received: true };
  }
}

function parse(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
}
