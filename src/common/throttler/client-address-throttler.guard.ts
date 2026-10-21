import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { clientAddressOf } from '../client-address';

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
}
