import { Global, Module } from '@nestjs/common';
import {
  RATE_LIMIT_NAMESPACE,
  RATE_LIMIT_NAMESPACE_DEPLOYED,
  RateLimitStore,
} from './rate-limit-store';

/**
 * The stored rate-limit counts (card C8-3): `RateLimitStore`, which the one
 * `ThrottlerModule` uses as its storage (`cnc-auth.module.ts`) and which a
 * route that counts by hand (the webhook) and the tokens sweep inject.
 * Global, like the Prisma module it writes through, so there is one store
 * and one namespace in the process.
 */
@Global()
@Module({
  providers: [
    { provide: RATE_LIMIT_NAMESPACE, useValue: RATE_LIMIT_NAMESPACE_DEPLOYED },
    RateLimitStore,
  ],
  exports: [RateLimitStore],
})
export class RateLimitModule {}
