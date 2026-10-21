import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { TableSessionsService } from './table-sessions.service';
import { FloorController, TablesController } from './tables.controller';

/**
 * Reception (card C4-7): reservations, table sessions, the floor read and
 * the Free Table Reminder.
 *
 * `ReservationsService.book` is exported for the website's and the app's
 * bookings (C6-5), which run the same command. `TableSessionsService` is
 * exported for the staff bell.
 *
 * No `AuditRefAccess` reader is registered for booking numbers (`RSV-`)
 * or table refs (`D-B1`): plan §4.8 lets a non-manager read the history of
 * an order or docket, a request, a purchase, a waste entry, an online
 * order or a task, and neither is on the list, so the registry's
 * fail-closed answer is the rule. Managers read them in Activity History.
 */
@Module({
  imports: [CncAuthModule, AuditModule],
  controllers: [ReservationsController, TablesController, FloorController],
  providers: [ReservationsService, TableSessionsService],
  exports: [ReservationsService, TableSessionsService],
})
export class ReceptionModule {}
