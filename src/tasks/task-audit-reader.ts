import type { AuditRefReader } from '../audit/audit-ref-access';
import type { CncPrismaService } from '../prisma/cnc-prisma.service';
import { pagesFor } from '../shell/staff-pages';
import { seesTask } from './task-rules';

/** Task numbers: `T-000001`. */
const TASK_REF = /^T-\d+$/;

/**
 * Who besides a manager may read a task's history
 * (`GET /staff/audit?ref=T-…`, plan §4.8): a role that opens Tasks
 * (Reception, the Cashier, the Kitchen, the Storekeeper), for a task their
 * own tasks read shows them (`seesTask`: assigned to them, or raised by
 * them). The task must exist: a ref nobody issued gets the registry's
 * refusal. Managers never reach this reader; their rule is the actor
 * filter.
 */
export function taskRefReader(
  prisma: Pick<CncPrismaService, 'task'>,
): AuditRefReader {
  return {
    owns: (ref) => TASK_REF.test(ref),
    mayRead: async (viewer, ref) => {
      if (!pagesFor(viewer.role).includes('tasks')) return false;

      const task = await prisma.task.findUnique({
        where: { number: ref },
        select: { assignedToId: true, raisedById: true, automatic: true },
      });

      return task !== null && seesTask(viewer, task);
    },
  };
}
