import { Module } from '@nestjs/common';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { CustomerNotificationsController } from './customer-notifications.controller';
import { CustomerNotificationsService } from './customer-notifications.service';

/**
 * The customer's in-app list (card C6-8): `GET /me/notifications`,
 * `POST /me/notifications/read`, and `CustomerNotificationsService` for
 * the modules whose events write to it (customers for the welcome,
 * reception for bookings; C7 adds orders). It depends on nothing but the
 * database and the customer guard, so every writer can import it without
 * a cycle.
 */
@Module({
  imports: [CncAuthModule],
  controllers: [CustomerNotificationsController],
  providers: [CustomerNotificationsService, ClientAddressThrottlerGuard],
  exports: [CustomerNotificationsService],
})
export class CustomerNotificationsModule {}
