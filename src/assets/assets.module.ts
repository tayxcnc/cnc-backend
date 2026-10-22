import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditRefAccess } from '../audit/audit-ref-access';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { maintenanceRefReader } from './maintenance-audit-reader';
import { MaintenanceService } from './maintenance.service';

/**
 * Assets & Maintenance (card C5-6): `asset.save`, `maintenance.save` and
 * their reads. A repair's follow-up task is raised and closed through
 * `src/tasks/automatic-tasks.ts`, plain functions called in the command's
 * transaction, so this module imports nothing from Tasks.
 *
 * Registers the `AuditRefAccess` reader for repair numbers (`MT-`), which
 * plan §4.8 lets Reception read.
 */
@Module({
  imports: [CncAuthModule, AuditModule],
  controllers: [AssetsController],
  providers: [AssetsService, MaintenanceService],
})
export class AssetsModule implements OnModuleInit {
  constructor(
    private readonly refAccess: AuditRefAccess,
    private readonly prisma: CncPrismaService,
  ) {}

  onModuleInit(): void {
    this.refAccess.register(maintenanceRefReader(this.prisma));
  }
}
