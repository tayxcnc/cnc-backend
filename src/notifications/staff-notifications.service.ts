import { Injectable } from '@nestjs/common';
import { StaffRole, TaskStatus } from '../../generated/cnc-client';
import type { StaffPrincipal } from '../auth/staff-principal';
import { isManager } from '../auth/staff-roles';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type PaginationQuery,
} from '../common/dto/pagination.query';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import type { StaffBellItem } from '../reception/free-table-reminder';
import { TableSessionsService } from '../reception/table-sessions.service';
import { pagesFor } from '../shell/staff-pages';
import { assignedTaskItem } from '../tasks/assigned-task-item';

/**
 * The staff bell (plan §9.1), computed on read and polled by the staff app
 * (A20). It ports `staff/lib/notifications.ts` one item at a time, as the
 * records each item reads are built: the Free Table Reminder (card C4-7;
 * the C4 gate's step 11), for Reception and managers with no alert switch,
 * as in the demo; and, from C5-3, the reader's assigned tasks that are not
 * Done (the C5 gate's step 2: the receive task reaches the Storekeeper),
 * last, as in the demo. Card C8-2 adds the other items here, each with its
 * own roles and alert switch, and with the managers' Purchase Approval
 * item the demo's rule that hides a manager's own review tasks while the
 * approvals alert is on.
 */
@Injectable()
export class StaffNotificationsService {
  constructor(
    private readonly tables: TableSessionsService,
    private readonly prisma: CncPrismaService,
  ) {}

  async list(
    actor: StaffPrincipal,
    query: PaginationQuery,
  ): Promise<{
    data: StaffBellItem[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const now = new Date();
    const items: StaffBellItem[] = [];

    if (isManager(actor.role) || actor.role === StaffRole.RECEPTION) {
      items.push(...(await this.tables.freeTableReminders(now)));
    }

    // Only for a role that can open Tasks, so the item's page always opens
    // (a Waiter or Bartender is never given a task, but an account whose
    // role changed may still hold one).
    if (pagesFor(actor.role).includes('tasks')) {
      const tasks = await this.prisma.task.findMany({
        where: { assignedToId: actor.id, status: { not: TaskStatus.DONE } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, title: true, status: true },
      });

      items.push(...tasks.map(assignedTaskItem));
    }

    return {
      data: items.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: items.length,
    };
  }
}
