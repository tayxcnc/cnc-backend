import { Module } from '@nestjs/common';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { AuditQueryService } from './audit-query.service';
import { AuditController } from './audit.controller';
import { AuditModule } from './audit.module';

/**
 * `GET /staff/audit`. Separate from `AuditModule` (the writer), as TAY's
 * viewer is from its writer: this controller needs `CncAuthModule`'s guard,
 * and `CncAuthModule` imports `AuditModule` to audit password changes.
 */
@Module({
  imports: [CncAuthModule, AuditModule],
  controllers: [AuditController],
  providers: [AuditQueryService],
})
export class AuditViewerModule {}
