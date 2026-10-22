import { Module } from '@nestjs/common';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { MoneyControlModule } from '../money-control/money-control.module';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { WasteModule } from '../waste/waste.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

/**
 * Approvals (card C5-8): `GET /staff/approvals`, the managers' read of the
 * requisitions and waste entries awaiting a decision. It lists them through
 * `PurchasesService` and `WasteService` (the same answers as their own
 * screens) and predicts each decision through `MoneyControlService`. No
 * `AuditRefAccess` reader: the screen is managers only, and managers read
 * the history already.
 */
@Module({
  imports: [CncAuthModule, MoneyControlModule, PurchasingModule, WasteModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
})
export class ApprovalsModule {}
