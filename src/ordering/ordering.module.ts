import { Module } from '@nestjs/common';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { PaymentsModule } from '../payments/payments.module';
import { SettingsModule } from '../settings/settings.module';
import { CheckoutsController } from './checkouts.controller';
import { CheckoutsService } from './checkouts.service';
import { OrderingController } from './ordering.controller';
import { OrderingService } from './ordering.service';

/**
 * Online ordering (plan §5.1). From C6-4 the public reads, the config and
 * the slots; from C7-1 the quote and the checkout, which starts its
 * payment through `PaymentsModule`'s Paystack client.
 */
@Module({
  imports: [CncAuthModule, SettingsModule, PaymentsModule],
  controllers: [OrderingController, CheckoutsController],
  providers: [OrderingService, CheckoutsService, ClientAddressThrottlerGuard],
  exports: [OrderingService, CheckoutsService],
})
export class OrderingModule {}
