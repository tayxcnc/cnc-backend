import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditRefAccess } from '../audit/audit-ref-access';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { MoneyControlModule } from '../money-control/money-control.module';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { StockModule } from '../stock/stock.module';
import { wasteRefReader } from './waste-audit-reader';
import { WasteController } from './waste.controller';
import { WasteService } from './waste.service';

/**
 * Waste (card C5-4): `waste.create`, `waste.approve`, `waste.reject`,
 * `waste.edit` and `waste.status`, and the waste read.
 *
 * Stock moves only through the stock core's `StockLedgerService`; the
 * money rules come from `MoneyControlService`, the valuation from
 * `stockValueKobo`. Registers the `AuditRefAccess` reader for waste numbers
 * (`W-`), which plan §4.8 lets each logging role read for its own
 * location.
 */
@Module({
  imports: [CncAuthModule, AuditModule, MoneyControlModule, StockModule],
  controllers: [WasteController],
  providers: [WasteService],
})
export class WasteModule implements OnModuleInit {
  constructor(
    private readonly refAccess: AuditRefAccess,
    private readonly prisma: CncPrismaService,
  ) {}

  onModuleInit(): void {
    this.refAccess.register(wasteRefReader(this.prisma));
  }
}
