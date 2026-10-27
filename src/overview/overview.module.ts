import { Module } from '@nestjs/common';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { KitchenModule } from '../kitchen/kitchen.module';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { ShellModule } from '../shell/shell.module';
import { WasteModule } from '../waste/waste.module';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';

/**
 * The overview (card C8-1): `GET /staff/overview`. Read only. It reads the
 * layout through the shell, the crosscheck count through the kitchen's
 * own report, and the approvals counts through purchasing and waste, so
 * each figure is the one its own screen shows.
 */
@Module({
  imports: [
    CncAuthModule,
    ShellModule,
    KitchenModule,
    PurchasingModule,
    WasteModule,
  ],
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class OverviewModule {}
