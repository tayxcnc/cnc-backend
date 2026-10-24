import { Module } from '@nestjs/common';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { ReceptionModule } from '../reception/reception.module';
import { StaffNotificationsController } from './staff-notifications.controller';
import { StaffNotificationsService } from './staff-notifications.service';

/**
 * The staff bell (plan §9.1): `GET /staff/notifications`. Each item's
 * records belong to their own module, which exports what the bell reads:
 * its filters (`AWAITING_APPROVAL`, `OPEN_REQUEST_STATUSES`,
 * `UNSETTLED_ORDER_STATUSES`, `ACTIVE_ONLINE_STATUSES`), its words, and
 * Reception's Free Table Reminder.
 */
@Module({
  imports: [CncAuthModule, ReceptionModule],
  controllers: [StaffNotificationsController],
  providers: [StaffNotificationsService],
})
export class NotificationsModule {}
