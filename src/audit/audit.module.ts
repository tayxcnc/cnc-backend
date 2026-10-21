import { Module } from '@nestjs/common';
import { AuditRefAccess } from './audit-ref-access';
import { AuditService } from './audit.service';

/**
 * The one writer of `AuditLog`, and the registry of record readers the
 * history read consults for non-managers.
 *
 * Not global, as TAY's `ActivityLogModule` is not: the modules that import
 * this one are the modules whose commands are audited, and that list is
 * worth being able to read. The reader (`GET /staff/audit`) is
 * `AuditViewerModule`, separate because its controller needs
 * `CncAuthModule`'s guard while `CncAuthModule` imports this module to audit
 * password changes; one module would import the other both ways.
 */
@Module({
  providers: [AuditService, AuditRefAccess],
  exports: [AuditService, AuditRefAccess],
})
export class AuditModule {}
