import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiExcludeController,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { OutboundMessagesService } from '../mail/outbound-messages.service';
import { PaymentSweepsService } from '../payments/payment-sweeps.service';
import { ReservationRemindersService } from '../reception/reservation-reminders.service';
import { CheckoutsSweepResponse } from './dto/checkouts-sweep.response';
import { MessagesSweepResponse } from './dto/messages-sweep.response';
import { PaymentsSweepResponse } from './dto/payments-sweep.response';
import { RemindersSweepResponse } from './dto/reminders-sweep.response';
import { TokensSweepResponse } from './dto/tokens-sweep.response';
import { SWEEP_TOKEN_HEADER, SweepTokenGuard } from './sweep-token.guard';
import { TokensSweepService } from './tokens-sweep.service';

/**
 * The housekeeping sweeps, as routes Cloud Scheduler calls (plan §5.5),
 * copied from TAY's `SweepsController` (§11). C3-9 adds the tokens sweep;
 * C6-1 the messages sweep (the outbound queue's retry, built with the first
 * email CNC sends); C6-8 the reminders sweep; C7-5 the checkouts and
 * payments sweeps (`PaymentSweepsService`). Each has its Scheduler job (*Infrastructure* in
 * `docs/conventions.md` lists them).
 *
 * ## Housekeeping, not correctness
 *
 * Nothing in this service depends on a sweep having run, and no later card
 * may make it so. Cloud Run scales to zero and a Scheduler job can fail, so
 * every rule a sweep tidies after is already enforced where the row is
 * used. A sweep stops tables filling with rows whose state is a lie.
 *
 * ## Not staff routes, no throttle, not published
 *
 * Only the scheduler calls these (see `SweepTokenGuard`). A wrong token is
 * a 401 before any query runs, so a flood costs a string comparison, which
 * is what a throttler would cost anyway. `@ApiExcludeController` keeps them
 * out of the published contract: Swagger is browsable on staging, and no
 * frontend calls them.
 */
@ApiTags('Internal')
@ApiExcludeController()
@Controller('internal/sweeps')
@UseGuards(SweepTokenGuard)
export class SweepsController {
  private readonly logger = new Logger(SweepsController.name);

  constructor(
    private readonly tokens: TokensSweepService,
    private readonly messages: OutboundMessagesService,
    private readonly reminders: ReservationRemindersService,
    private readonly payments: PaymentSweepsService,
  ) {}

  @Post('tokens')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'sweepTokens',
    summary: 'Delete expired tokens, codes and old idempotency keys',
    description:
      'Daily (cnc-staging-sweep-tokens). Expired refresh and password-reset ' +
      'tokens, one-time codes a day past their expiry, and stored ' +
      'Idempotency-Key responses older than 7 days. A revoked refresh token ' +
      'is kept until it expires.',
  })
  @ApiHeader({
    name: SWEEP_TOKEN_HEADER,
    description: 'The shared secret, `CNC_SWEEP_TOKEN`.',
    required: true,
  })
  @ApiResponse({ status: 200, type: TokensSweepResponse })
  @ApiResponse({
    status: 401,
    description: 'The token is absent, wrong, or not configured.',
    type: ApiErrorResponse,
  })
  async tokensSweep(): Promise<TokensSweepResponse> {
    const result = await this.tokens.sweep(new Date());

    // One line per run, even at zero: for these routes "it ran and there was
    // nothing to do" is the fact worth having. The request id is on it from
    // the logging context, so a surprising count can be found by it.
    this.logger.log(
      `Sweep tokens deleted ${result.refreshTokens} refresh token(s), ` +
        `${result.passwordResetTokens} password-reset token(s), ` +
        `${result.otpCodes} one-time code(s), ` +
        `${result.idempotencyKeys} idempotency key(s) and ` +
        `${result.rateLimitCounts} rate-limit count(s).`,
    );

    return result;
  }

  @Post('messages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'sweepMessages',
    summary: 'Retry outbound email that has not gone',
    description:
      'Every 5 minutes (cnc-staging-sweep-messages). Gives up on messages ' +
      'past their expiry, then retries waiting and failed messages, ' +
      'oldest first, 50 a run, 3 attempts each, a failed one only after ' +
      'its backoff (5 minutes, then 30). While mail is not configured a ' +
      'message waits without spending an attempt.',
  })
  @ApiHeader({
    name: SWEEP_TOKEN_HEADER,
    description: 'The shared secret, `CNC_SWEEP_TOKEN`.',
    required: true,
  })
  @ApiResponse({ status: 200, type: MessagesSweepResponse })
  @ApiResponse({
    status: 401,
    description: 'The token is absent, wrong, or not configured.',
    type: ApiErrorResponse,
  })
  async messagesSweep(): Promise<MessagesSweepResponse> {
    const result = await this.messages.sweep(new Date());

    this.logger.log(
      `Sweep messages sent ${result.sent}, failed ${result.failed}, left ` +
        `${result.waiting} waiting and gave up ${result.expired}.`,
    );

    return result;
  }

  @Post('reminders')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'sweepReminders',
    summary: 'Send the booking reminders that are due',
    description:
      'Every 15 minutes (cnc-staging-sweep-reminders). Q32: each Confirmed ' +
      'booking is reminded once, 24 hours before it starts; none for a ' +
      'booking made or moved under 24 hours ahead; guests by email; a ' +
      'customer who switched reminders off gets the in-app item only. ' +
      'Stamps reminderSentAt.',
  })
  @ApiHeader({
    name: SWEEP_TOKEN_HEADER,
    description: 'The shared secret, `CNC_SWEEP_TOKEN`.',
    required: true,
  })
  @ApiResponse({ status: 200, type: RemindersSweepResponse })
  @ApiResponse({
    status: 401,
    description: 'The token is absent, wrong, or not configured.',
    type: ApiErrorResponse,
  })
  async remindersSweep(): Promise<RemindersSweepResponse> {
    const result = await this.reminders.sweep(new Date());

    this.logger.log(
      `Sweep reminders reminded ${result.reminded} booking(s): ` +
        `${result.emailed} emailed, ${result.switchedOff} switched off.`,
    );

    return result;
  }

  @Post('checkouts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'sweepCheckouts',
    summary: 'Recheck checkouts past their expiry with Paystack',
    description:
      'Every 10 minutes (cnc-staging-sweep-checkouts). Each PENDING ' +
      'checkout past expiresAt, oldest first, 50 a run, is verified with ' +
      'Paystack: paid, its order is written (a webhook that never came); ' +
      'paid wrongly, it is held as Needs Attention; never paid, it expires ' +
      'and burns no order number. Unreachable: left for the next run.',
  })
  @ApiHeader({
    name: SWEEP_TOKEN_HEADER,
    description: 'The shared secret, `CNC_SWEEP_TOKEN`.',
    required: true,
  })
  @ApiResponse({ status: 200, type: CheckoutsSweepResponse })
  @ApiResponse({
    status: 401,
    description: 'The token is absent, wrong, or not configured.',
    type: ApiErrorResponse,
  })
  async checkoutsSweep(): Promise<CheckoutsSweepResponse> {
    const result = await this.payments.sweepCheckouts(new Date());

    this.logger.log(
      `Sweep checkouts checked ${result.checked}: ${result.paid} paid, ` +
        `${result.held} held, ${result.expired} expired, ` +
        `${result.unreachable} unreachable.`,
    );

    return result;
  }

  @Post('payments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'sweepPayments',
    summary: 'Handle webhook deliveries that were recorded and not processed',
    description:
      'Every 15 minutes (cnc-staging-sweep-payments). Each PaymentEvent ' +
      'with processedAt null and older than 5 minutes, oldest first, 50 a ' +
      'run, is dispatched again by its event and reference (no body is ' +
      'stored) and marked processed; a failure leaves it for the next run.',
  })
  @ApiHeader({
    name: SWEEP_TOKEN_HEADER,
    description: 'The shared secret, `CNC_SWEEP_TOKEN`.',
    required: true,
  })
  @ApiResponse({ status: 200, type: PaymentsSweepResponse })
  @ApiResponse({
    status: 401,
    description: 'The token is absent, wrong, or not configured.',
    type: ApiErrorResponse,
  })
  async paymentsSweep(): Promise<PaymentsSweepResponse> {
    const result = await this.payments.sweepPayments(new Date());

    this.logger.log(
      `Sweep payments redispatched ${result.redispatched} delivery(ies), ` +
        `${result.failed} failed again.`,
    );

    return result;
  }
}
