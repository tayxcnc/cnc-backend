import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { StockModule } from '../stock/stock.module';
import { WasteModule } from '../waste/waste.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Reports (card C8-1): Sales, Payments Received, Daily Transfers, Stock
 * Movements, Waste, Maintenance History and Vendor Spend, under
 * `staff/reports` beside the Kitchen Crosscheck (`KitchenModule`) and Cash
 * Reconciliation (`CashModule`). Read only; it registers no
 * `AuditRefAccess` reader, because a report is not a record.
 *
 * The movements, waste entries and repairs are answered by their own
 * modules' services, so a row reads the same here as on its own screen.
 */
@Module({
  imports: [CncAuthModule, StockModule, WasteModule, AssetsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
