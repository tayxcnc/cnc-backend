import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { MoneyControlModule } from '../money-control/money-control.module';
import { KitchenMappingService } from './kitchen-mapping.service';
import { KitchenMappingsController } from './kitchen-mappings.controller';
import { StockLedgerService } from './stock-ledger.service';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';

/**
 * The stock core (card C4-2): balances, movements, direct issue, count,
 * Correct Balance, stock items and the kitchen comparison rules.
 *
 * `StockLedgerService` is exported: it is the one writer of balances and
 * movements, and the till (Bar settlement and reversal), the kitchen
 * entries, requests, purchases, waste and paid web orders move stock only
 * through it. `KitchenMappingService` is exported for the crosscheck.
 *
 * No `AuditRefAccess` reader is registered: plan §4.8 lets a non-manager
 * read the history of an order or docket, a request, a purchase, a waste
 * entry, an online order or a task, and none of this module's refs (a
 * stock item, a location, a dish's slug) is among them, so the registry's
 * fail-closed answer is the rule.
 */
@Module({
  imports: [CncAuthModule, AuditModule, MoneyControlModule],
  controllers: [StockController, KitchenMappingsController],
  providers: [StockService, StockLedgerService, KitchenMappingService],
  exports: [StockLedgerService, KitchenMappingService],
})
export class StockModule {}
