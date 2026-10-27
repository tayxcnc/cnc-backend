import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import { clientAddressOf } from '../client-address';

/** The header a refused request carries: whole seconds until it may retry. */
export const RETRY_AFTER_HEADER = 'Retry-After';

/**
 * Rate limiting keyed on the real client address rather than the proxy's,
 * copied from TAY's `ClientAddressThrottlerGuard`.
 *
 * On Cloud Run every request arrives through Google's load balancer, so
 * `req.ip` without the trusted-hop setting is the balancer for every visitor
 * on earth: three sign-ins from one person would exhaust the limit for
 * everybody. `clientAddressOf` picks the hop Google observed, and is the same
 * function the audit log stamps addresses with, so the address a limit
 * counted and the address a record shows cannot be two different ideas of
 * who the caller was. Everything unidentifiable shares one `unknown` bucket,
 * which fails closed.
 *
 * A refusal (429) carries a standard `Retry-After` in seconds (C8-3), as
 * well as the throttler's own `Retry-After-<count>` for the count that
 * refused it: a client or a proxy reads the standard name only.
 *
 * Register `ThrottlerModule` in the module whose routes use this guard; it
 * resolves the options and storage from there.
 */
@Injectable()
export class ClientAddressThrottlerGuard extends ThrottlerGuard {
  // No constructor. The parent's takes options, storage and a Reflector, and
  // Nest finds them through the prototype chain; declaring one here without
  // repeating those three parameters is what would break injection.

  protected getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(clientAddressOf(req));
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const { res } = this.getRequestResponse(context);

    (res as { header(name: string, value: string): void }).header(
      RETRY_AFTER_HEADER,
      String(Math.max(1, detail.timeToBlockExpire)),
    );

    return super.throwThrottlingException(context, detail);
  }
}
