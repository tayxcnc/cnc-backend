import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { CashCountsController } from './cash-counts.controller';
import { CashCountsService } from './cash-counts.service';

/**
 * The cash count (card C4-8): `cash.count` and the Cash Reconciliation
 * report.
 *
 * No `AuditRefAccess` reader is registered for `CASH-` refs: plan §4.8
 * lets a non-manager read the history of an order or docket, a request, a
 * purchase, a waste entry, an online order or a task, and a cash count is
 * not among them; the Cashier reads the counts through the report.
 */
@Module({
  imports: [CncAuthModule, AuditModule],
  controllers: [CashCountsController],
  providers: [CashCountsService],
})
export class CashModule {}
