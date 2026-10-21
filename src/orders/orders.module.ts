import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditRefAccess } from '../audit/audit-ref-access';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { DocketsController } from './dockets.controller';
import { DocketsService } from './dockets.service';
import { docketRefReader, orderRefReader } from './order-audit-readers';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

/**
 * Point of Sale's bills, lines and kitchen dockets (cards C4-3 and C4-4).
 *
 * `OrdersService` (`claimOrder`, `readOrder`, `lines`) and `DocketsService`
 * (`write`, `latestByRef`) are exported: payments, settlement and the
 * manager corrections (C4-5), the kitchen entries (C4-6) and the web order
 * (C7) build on them rather than restating how a bill is locked, read or
 * sent to the kitchen.
 *
 * Registers the `AuditRefAccess` readers for bill numbers (`CNCR-`,
 * `CNCB-`) and docket refs (`KOT-`), so the Point of Sale and Kitchen roles
 * can read those records' history (plan §4.8).
 */
@Module({
  imports: [CncAuthModule, AuditModule],
  controllers: [OrdersController, DocketsController],
  providers: [OrdersService, DocketsService],
  exports: [OrdersService, DocketsService],
})
export class OrdersModule implements OnModuleInit {
  constructor(
    private readonly refAccess: AuditRefAccess,
    private readonly prisma: CncPrismaService,
  ) {}

  onModuleInit(): void {
    this.refAccess.register(orderRefReader(this.prisma));
    this.refAccess.register(docketRefReader(this.prisma));
  }
}
