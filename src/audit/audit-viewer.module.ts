import { Module } from '@nestjs/common';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { AuditQueryService } from './audit-query.service';
import { AuditController } from './audit.controller';
import { AuditModule } from './audit.module';
import { PrintController } from './print.controller';
import { PrintService } from './print.service';

/**
 * `GET /staff/audit`, and `POST /staff/audit/print` beside it. Separate
 * from `AuditModule` (the writer), as TAY's viewer is from its writer:
 * these controllers need `CncAuthModule`'s guard, and `CncAuthModule`
 * imports `AuditModule` to audit password changes.
 */
@Module({
  imports: [CncAuthModule, AuditModule],
  controllers: [AuditController, PrintController],
  providers: [AuditQueryService, PrintService],
})
export class AuditViewerModule {}
