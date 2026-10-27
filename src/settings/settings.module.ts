import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { MoneyControlModule } from '../money-control/money-control.module';
import { OpeningHoursService } from './opening-hours.service';
import { PublicSettingsController } from './public-settings.controller';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

/**
 * Settings, business details and opening hours (card C3-7), and their
 * public reads, `GET /business` and `GET /opening-hours` (C6-4). The read
 * services are exported for the staff shell's `GET /staff/reference`
 * (C3-8), the public room availability and the ordering times (C6-4).
 */
@Module({
  imports: [CncAuthModule, AuditModule, MoneyControlModule],
  controllers: [SettingsController, PublicSettingsController],
  providers: [SettingsService, OpeningHoursService],
  exports: [SettingsService, OpeningHoursService],
})
export class SettingsModule {}
