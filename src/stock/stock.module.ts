import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditRefAccess } from '../audit/audit-ref-access';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { MoneyControlModule } from '../money-control/money-control.module';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { KitchenMappingService } from './kitchen-mapping.service';
import { KitchenMappingsController } from './kitchen-mappings.controller';
import { StockLedgerService } from './stock-ledger.service';
import { stockRequestRefReader } from './stock-request-audit-reader';
import { StockRequestsController } from './stock-requests.controller';
import { StockRequestsService } from './stock-requests.service';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';

/**
 * Stock & Requests: the stock core (card C4-2: balances, movements, direct
 * issue, count, Correct Balance, stock items and the kitchen comparison
 * rules) and the stock requests (card C5-2).
 *
 * `StockLedgerService` is exported: it is the one writer of balances and
 * movements, and the till (Bar settlement and reversal), the kitchen
 * entries, requests, purchases, waste and paid web orders move stock only
 * through it. `KitchenMappingService` is exported for the crosscheck, and
 * `StockService` for Reports → Stock Movements (C8-1), which reads the
 * movements as this module's own read does.
 *
 * Registers the `AuditRefAccess` reader for request numbers (`SR-`), which
 * plan §4.8 lets the Storekeeper, the Kitchen and a Bartender read. No
 * reader is registered for the stock core's refs (a stock item, a
 * location, a dish's slug): none is on §4.8's list, so the registry's
 * fail-closed answer is the rule.
 */
@Module({
  imports: [CncAuthModule, AuditModule, MoneyControlModule],
  controllers: [
    StockController,
    StockRequestsController,
    KitchenMappingsController,
  ],
  providers: [
    StockService,
    StockRequestsService,
    StockLedgerService,
    KitchenMappingService,
  ],
  exports: [StockLedgerService, KitchenMappingService, StockService],
})
export class StockModule implements OnModuleInit {
  constructor(
    private readonly refAccess: AuditRefAccess,
    private readonly prisma: CncPrismaService,
  ) {}

  onModuleInit(): void {
    this.refAccess.register(stockRequestRefReader(this.prisma));
  }
}
