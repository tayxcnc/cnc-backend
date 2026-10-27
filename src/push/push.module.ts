import { Module } from '@nestjs/common';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { CncConfigService } from '../config/cnc.config';
import { CustomerPushController } from './customer-push.controller';
import { PushQueueService } from './push-queue.service';
import { PUSH_SENDER, pushSenderFor } from './push-sender';
import {
  PUSH_PUBLIC_KEY,
  PushSubscriptionsService,
} from './push-subscriptions.service';
import { StaffPushController } from './staff-push.controller';

/**
 * Web push (C10): each realm's subscribe routes (`/me/push`,
 * `/staff/push`), the one sender (`PUSH_SENDER`: `web-push` where
 * `CNC_VAPID_*` is configured, a disabled one otherwise), and
 * `PushQueueService` for the modules whose events push.
 *
 * **A leaf.** It imports only `CncAuthModule`, for its own controllers'
 * guards (the Prisma client and the config are global), and nothing
 * imports it but the modules that push: `CncAuthModule` never does. The
 * sign-out side, forgetting a person's devices, is the plain function
 * `forgetPushSubject`, which the token service calls without this module,
 * so no cycle runs through auth.
 *
 * `PUSH_SENDER` and `PUSH_PUBLIC_KEY` are providers of their own so the
 * e2e harness replaces them (`createTestApp`): no suite reaches a push
 * service, and a suite chooses whether push is configured.
 */
@Module({
  imports: [CncAuthModule],
  controllers: [CustomerPushController, StaffPushController],
  providers: [
    {
      provide: PUSH_SENDER,
      inject: [CncConfigService],
      useFactory: pushSenderFor,
    },
    {
      provide: PUSH_PUBLIC_KEY,
      inject: [CncConfigService],
      useFactory: (config: CncConfigService): string | null =>
        config.vapid()?.publicKey ?? null,
    },
    PushQueueService,
    PushSubscriptionsService,
    ClientAddressThrottlerGuard,
  ],
  exports: [PushQueueService],
})
export class PushModule {}
