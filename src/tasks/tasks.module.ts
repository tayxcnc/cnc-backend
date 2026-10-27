import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditRefAccess } from '../audit/audit-ref-access';
import { AuditModule } from '../audit/audit.module';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { PushModule } from '../push/push.module';
import { taskRefReader } from './task-audit-reader';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * Tasks (card C5-5): `task.save` and the tasks read. The tasks commands
 * raise and close by themselves are `automatic-tasks.ts`'s, called inside
 * those commands' own transactions; they are plain functions, not
 * providers, so no module imports this one for them. A task's push to its
 * assignee (C10, PS9) goes through `PushModule`.
 *
 * Registers the `AuditRefAccess` reader for task numbers (`T-`), which
 * plan §4.8 lets a person read for the tasks they see.
 */
@Module({
  imports: [CncAuthModule, AuditModule, PushModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule implements OnModuleInit {
  constructor(
    private readonly refAccess: AuditRefAccess,
    private readonly prisma: CncPrismaService,
  ) {}

  onModuleInit(): void {
    this.refAccess.register(taskRefReader(this.prisma));
  }
}
