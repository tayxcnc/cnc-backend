import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditRefAccess } from '../audit/audit-ref-access';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { MoneyControlModule } from '../money-control/money-control.module';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { StockModule } from '../stock/stock.module';
import { purchaseRefReader } from './purchase-audit-reader';
import { PurchasesController } from './purchases.controller';
import { PurchasesService } from './purchases.service';
import { VendorsController } from './vendors.controller';
import { VendorsService } from './vendors.service';

/**
 * Purchasing and Vendors (card C5-3): requisitions from raising to
 * receiving, with their automatic tasks, and `vendor.save`.
 *
 * Receiving and correcting move Store stock through the stock core's
 * `StockLedgerService`; the money rules come from `MoneyControlService`.
 * Registers the `AuditRefAccess` reader for purchase numbers (`PR-`),
 * which plan §4.8 lets the Storekeeper read. No reader is registered for
 * vendors: §4.8 gives no non-manager a vendor's history.
 */
@Module({
  imports: [CncAuthModule, AuditModule, MoneyControlModule, StockModule],
  controllers: [PurchasesController, VendorsController],
  providers: [PurchasesService, VendorsService],
})
export class PurchasingModule implements OnModuleInit {
  constructor(
    private readonly refAccess: AuditRefAccess,
    private readonly prisma: CncPrismaService,
  ) {}

  onModuleInit(): void {
    this.refAccess.register(purchaseRefReader(this.prisma));
  }
}
