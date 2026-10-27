import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { CustomerNotificationsModule } from '../customer-notifications/customer-notifications.module';
import { MailModule } from '../mail/mail.module';
import { PushModule } from '../push/push.module';
import {
  CustomerReservationsController,
  PublicReservationsController,
} from './customer-reservations.controller';
import { CustomerReservationsService } from './customer-reservations.service';
import { PublicVenuesController } from './public-venues.controller';
import { PublicVenuesService } from './public-venues.service';
import { ReservationMail } from './reservation-mail';
import { ReservationRemindersService } from './reservation-reminders.service';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { TableSessionsService } from './table-sessions.service';
import { FloorController, TablesController } from './tables.controller';

/**
 * Reception (card C4-7): reservations, table sessions, the floor read and
 * the Free Table Reminder; the booking page's public reads,
 * `GET /venues` and `GET /venues/:venue/availability` (C6-4); and the
 * guest's side of bookings (C6-5, C6-6): `POST /reservations` from the
 * website and the app, and the customer's own `/me/reservations`.
 *
 * Every booking, whatever its channel, is `ReservationsService.book`; the
 * guest's routes reach it through `CustomerReservationsService`. Booking
 * emails go through `MailModule`'s queue and the in-app items through
 * `CustomerNotificationsModule`, both written by `ReservationMail`. The
 * reminders (Q32, C6-8) are `ReservationRemindersService`, exported for
 * the sweep route. `TableSessionsService` is exported for the staff bell
 * and the push sweep. `PushModule` (C10) queues the bookings' pushes.
 *
 * No `AuditRefAccess` reader is registered for booking numbers (`RSV-`)
 * or table refs (`D-B1`): plan §4.8 lets a non-manager read the history of
 * an order or docket, a request, a purchase, a waste entry, an online
 * order or a task, and neither is on the list, so the registry's
 * fail-closed answer is the rule. Managers read them in Activity History.
 */
@Module({
  imports: [
    CncAuthModule,
    AuditModule,
    MailModule,
    CustomerNotificationsModule,
    PushModule,
  ],
  controllers: [
    ReservationsController,
    TablesController,
    FloorController,
    PublicVenuesController,
    PublicReservationsController,
    CustomerReservationsController,
  ],
  providers: [
    ReservationsService,
    TableSessionsService,
    PublicVenuesService,
    ReservationMail,
    ReservationRemindersService,
    CustomerReservationsService,
    ClientAddressThrottlerGuard,
  ],
  exports: [
    ReservationsService,
    TableSessionsService,
    ReservationRemindersService,
  ],
})
export class ReceptionModule {}
