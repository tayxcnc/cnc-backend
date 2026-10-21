import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { ImagesModule } from '../images/images.module';
import { MoneyControlModule } from '../money-control/money-control.module';
import { StaffCardService } from './staff-card.service';
import { StaffPeopleController } from './staff-people.controller';
import { StaffPeopleService } from './staff-people.service';

/**
 * Staff & Access (card C3-6). `CncAuthModule` supplies the guard and the
 * token service (sessions end on a role, email or status change),
 * `MoneyControlModule` the Manager/Owner and last-Owner rules, `ImagesModule`
 * the photographs.
 */
@Module({
  imports: [CncAuthModule, AuditModule, MoneyControlModule, ImagesModule],
  controllers: [StaffPeopleController],
  providers: [StaffPeopleService, StaffCardService],
  // The shell's My Staff ID reads the same card.
  exports: [StaffCardService],
})
export class StaffModule {}
