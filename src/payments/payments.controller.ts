import {
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { TOO_MANY_ATTEMPTS_MESSAGE } from '../auth/auth-throttle';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { RETRY_AFTER_HEADER } from '../common/throttler/client-address-throttler.guard';
import { RateLimitStore } from '../common/throttler/rate-limit-store';
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
 * Deliveries with a bad signature per client address per minute (C8-3).
 * **A correctly signed delivery is never counted or refused for volume**:
 * only Paystack holds the key, a replay of the same bytes changes nothing
 * (the `PaymentEvent` ledger), and refusing one would only delay a payment
 * until Paystack's retry or the payments sweep. Unsigned traffic is the
 * only volume worth stopping, and past this number it is answered 429
 * with `Retry-After` and no log line, so a flood cannot fill the log. The
 * number is the old per-address ceiling (TAY's H-2), now counted in the
 * stored counts every instance shares.
 */
export const WEBHOOK_BAD_SIGNATURE_LIMIT = 120;
export const WEBHOOK_BAD_SIGNATURE_WINDOW_MS = 60 * 1000;

/** The stored count's key: the route, then the address it counts. */
const BAD_SIGNATURE_KEY = 'payments-webhook:bad-signature:';

/**
 * How long a delivery's request waits for its own handling before it
 * answers anyway (`dispatchWithin`): five seconds. A verify (10 s timeout
 * at worst) and a settle normally take well under a second, and the
 * request must stay open while they run, because Cloud Run throttles an
 * instance's CPU outside requests; the cap keeps the answer well inside
 * the time Paystack waits before it retries.
 */
export const WEBHOOK_INLINE_WAIT_MS = 5 * 1000;

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
 * unique) and handled by `WebhookDispatcherService` while the request
 * waits up to `WEBHOOK_INLINE_WAIT_MS`, then acknowledged; anything slower
 * carries on after the answer. A replay of the same bytes finds the row
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
    private readonly rateLimits: RateLimitStore,
  ) {}

  // No throttler guard: it would count before the signature is checked,
  // and a signed delivery must never be refused for volume. The bad
  // signatures are counted below, after the check.
  @Post('webhook')
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
    description:
      'More than 120 deliveries with a bad signature in a minute from one ' +
      'address; with `Retry-After`. A correctly signed delivery is never ' +
      'refused for volume.',
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
    @Res({ passthrough: true }) response: Response,
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
      const counted = await this.rateLimits.hit(
        BAD_SIGNATURE_KEY + clientAddressOf(request),
        WEBHOOK_BAD_SIGNATURE_LIMIT,
        WEBHOOK_BAD_SIGNATURE_WINDOW_MS,
      );

      if (counted.blocked) {
        response.setHeader(
          RETRY_AFTER_HEADER,
          String(Math.max(1, counted.retryAfterSeconds)),
        );
        throw new HttpException(
          TOO_MANY_ATTEMPTS_MESSAGE,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

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
      await this.dispatcher.dispatchWithin(
        envelope,
        recorded.id,
        WEBHOOK_INLINE_WAIT_MS,
      );
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
