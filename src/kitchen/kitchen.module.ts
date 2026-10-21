import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { OrdersModule } from '../orders/orders.module';
import { StockModule } from '../stock/stock.module';
import { KitchenCrosscheckService } from './kitchen-crosscheck.service';
import { KitchenReportsController } from './kitchen-reports.controller';
import { KitchenController } from './kitchen.controller';
import { KitchenService } from './kitchen.service';

/**
 * The Kitchen (card C4-6): kitchen entries against docket numbers, the
 * kitchen day's close, and the Kitchen Crosscheck report.
 *
 * Builds on the orders module's `DocketsService` (the latest revision by
 * ref) and the stock module's `StockLedgerService` (the one writer of
 * balances) and `readKitchenMappings` (the comparison rules).
 *
 * No `AuditRefAccess` reader is registered: an entry's history is filed
 * under its `KOT-` ref, which the orders module's docket reader already
 * vouches for (Kitchen, Cashier, Waiter), and a closed day's ref is a date,
 * which plan §4.8 does not open to non-managers.
 */
@Module({
  imports: [CncAuthModule, AuditModule, OrdersModule, StockModule],
  controllers: [KitchenController, KitchenReportsController],
  providers: [KitchenService, KitchenCrosscheckService],
  exports: [KitchenCrosscheckService],
})
export class KitchenModule {}
