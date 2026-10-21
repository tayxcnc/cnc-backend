import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { CncConfigService } from '../config/cnc.config';

/** The header Cloud Scheduler sends the shared secret in (plan §5, label I). */
export const SWEEP_TOKEN_HEADER = 'x-sweep-token';

/** One answer for every refusal: absent, wrong, or not configured. */
export const SWEEP_TOKEN_REFUSED_MESSAGE = 'Invalid or missing sweep token.';

/**
 * The only thing in front of the sweep routes. Copied from TAY's guard
 * (plan §11), reading `CNC_SWEEP_TOKEN` through `CncConfigService`.
 *
 * ## Why a shared secret and not the staff guard
 *
 * Cloud Scheduler is not a staff member. Giving it an account would mean a
 * staff row with a password in a secret and a session that never ends. A
 * shared secret is the smallest credential that says "this caller is the
 * scheduler".
 *
 * ## The comparison
 *
 * Constant time, through `timingSafeEqual`: a comparison that returns at the
 * first differing byte tells a caller how much of the token they guessed.
 * The length check before it is not a leak worth closing (`timingSafeEqual`
 * throws on a length mismatch, so the alternative is an exception).
 *
 * **A service with no token configured refuses every call.** An unset
 * secret must never mean an open route. Staging and production cannot reach
 * that state, because `CncConfigService` refuses to boot there without a
 * token; locally it means no sweeps rather than public ones.
 *
 * The token is read on every request rather than at construction, so the
 * value in force is always the configuration's.
 */
@Injectable()
export class SweepTokenGuard implements CanActivate {
  constructor(private readonly config: CncConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const presented = context
      .switchToHttp()
      .getRequest<Request>()
      .header(SWEEP_TOKEN_HEADER);

    if (!isSweepTokenMatch(this.config.sweepToken, presented)) {
      throw new UnauthorizedException(SWEEP_TOKEN_REFUSED_MESSAGE);
    }

    return true;
  }
}

/**
 * Whether `presented` is the configured token, compared in constant time.
 * False when nothing is configured, and for an empty or non-text header.
 */
export function isSweepTokenMatch(
  expected: string | undefined,
  presented: unknown,
): boolean {
  if (expected === undefined || expected === '') return false;
  if (typeof presented !== 'string' || presented === '') return false;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
}
