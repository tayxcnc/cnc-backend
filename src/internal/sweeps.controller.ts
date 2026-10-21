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
import { TokensSweepResponse } from './dto/tokens-sweep.response';
import { SWEEP_TOKEN_HEADER, SweepTokenGuard } from './sweep-token.guard';
import { TokensSweepService } from './tokens-sweep.service';

/**
 * The housekeeping sweeps, as routes Cloud Scheduler calls (plan §5.5),
 * copied from TAY's `SweepsController` (§11). C3-9 adds the tokens sweep;
 * the messages and reminders sweeps arrive with C6-8, and the checkouts
 * and payments sweeps with C7-5, each with its Scheduler job.
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

  constructor(private readonly tokens: TokensSweepService) {}

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
        `${result.otpCodes} one-time code(s) and ` +
        `${result.idempotencyKeys} idempotency key(s).`,
    );

    return result;
  }
}
