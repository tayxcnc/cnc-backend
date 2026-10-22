import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  MaintenanceStatus,
  Prisma,
  TaskStatus,
  TaskType,
} from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { isManager } from '../auth/staff-roles';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import { drawNumber } from '../prisma/sequences';
import { isClosedPurchase } from '../purchasing/purchase-rules';
import type {
  CreateTaskRequest,
  TasksQuery,
  UpdateTaskRequest,
} from './dto/tasks.request';
import type { TaskPageResponse, TaskResponse } from './dto/tasks.response';
import {
  ASSIGNEE_MESSAGE,
  OPEN_MAINTENANCE_MESSAGE,
  OPEN_PURCHASE_MESSAGE,
  RAISE_TO_MESSAGE,
  TASK_NOT_FOUND_MESSAGE,
} from './task-messages';
import {
  isAssignable,
  linksFor,
  mayRaiseTo,
  nonManagerSaveProblem,
  type StoredTask,
  type TaskLinks,
  type TaskSave,
  visibleTasks,
} from './task-rules';

type Tx = Prisma.TransactionClient;

/** What the answers are read through: the pool, or a command's transaction. */
type Reader = Pick<
  Prisma.TransactionClient,
  'taskHistory' | 'staff' | 'purchase' | 'maintenanceRecord'
>;

/** The columns a task is answered from, without its relations. */
const TASK_COLUMNS = {
  id: true,
  number: true,
  title: true,
  type: true,
  status: true,
  assignedToId: true,
  raisedById: true,
  automatic: true,
  purchaseId: true,
  maintenanceId: true,
  createdAt: true,
  version: true,
} satisfies Prisma.TaskSelect;

type TaskRow = Prisma.TaskGetPayload<{ select: typeof TASK_COLUMNS }>;

/** The repairs a task can no longer be linked to (the demo's closed repairs). */
const CLOSED_REPAIRS: readonly MaintenanceStatus[] = [
  MaintenanceStatus.FIXED,
  MaintenanceStatus.NOT_FIXED,
];

/** An id field as sent: a non-blank string, or nothing. */
function sentId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A save's fields as the rules read them. */
function saveOf(request: CreateTaskRequest | UpdateTaskRequest): TaskSave {
  return {
    title: request.title,
    type: request.type,
    assignedToId: sentId(request.assignedToId),
    purchaseId: sentId(request.purchaseId),
    maintenanceId: sentId(request.maintenanceId),
  };
}

/**
 * Tasks (plan §4.7, §5.4, §6.1, §6.2; card C5-5): `task.save`, by which a
 * person raises a task and moves their own through Open, In Progress and
 * Done, and a manager assigns, edits and links any task; and the tasks
 * read. The tasks commands raise by themselves (a purchase's review and
 * receive tasks, a repair's follow-up) are `automatic-tasks.ts`'s; they are
 * read, saved and closed here like any other.
 *
 * - **Who may save** (D42's role gate): Reception, the Cashier, the
 *   Kitchen and the Storekeeper, and managers. A Waiter or Bartender has
 *   no Tasks page and is never given a task.
 * - **Anyone but a manager** raises a task to a manager or to themselves,
 *   and on a task that exists changes only the status, and only when it is
 *   assigned to them.
 * - **A manager** assigns any active member of staff but a Waiter or
 *   Bartender, and links a Purchase task to an open requisition or a
 *   Maintenance task to an open repair.
 *
 * Every save writes a `TaskHistory` row and its audit row in the same
 * transaction; an update claims the task's `version` first (A8), so a
 * save from a screen read before an automatic close is refused as stale.
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `GET /staff/tasks`: Open first, then In Progress, then Done, newest
   * first within each, as the Tasks screen orders them. Managers read every
   * task; anyone else the tasks assigned to them and those they raised
   * (`visibleTasks`).
   */
  async list(
    actor: StaffPrincipal,
    query: TasksQuery,
  ): Promise<TaskPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const visible = visibleTasks(actor);
    const filters: Prisma.TaskWhereInput[] = [visible];

    if (query.status) filters.push({ status: query.status });

    if (query.q) {
      const contains = {
        contains: query.q,
        mode: Prisma.QueryMode.insensitive,
      };

      filters.push({ OR: [{ number: contains }, { title: contains }] });
    }

    const where: Prisma.TaskWhereInput = { AND: filters };
    // Postgres orders an enum by its declared order: OPEN, IN_PROGRESS, DONE.
    const rows = await this.prisma.task.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: TASK_COLUMNS,
    });
    const total = await this.prisma.task.count({ where });
    const byStatus = await this.prisma.task.groupBy({
      by: ['status'],
      where: visible,
      _count: { _all: true },
    });
    const countOf = (status: TaskStatus) =>
      byStatus.find((group) => group.status === status)?._count._all ?? 0;

    return {
      data: await this.answerMany(this.prisma, rows),
      page,
      pageSize,
      total,
      counts: {
        open: countOf(TaskStatus.OPEN),
        inProgress: countOf(TaskStatus.IN_PROGRESS),
        done: countOf(TaskStatus.DONE),
      },
    };
  }

  /**
   * `task.save` raising a task, in the demo's order: the assignee a
   * non-manager may name (403), then the link the type needs, then an
   * assignee who may hold a task. The description, type and status were
   * checked by the DTO. Runs inside the idempotency service's transaction:
   * a retry after a lost response replays the first task instead of
   * raising a second.
   */
  async create(
    tx: Tx,
    actor: StaffPrincipal,
    request: CreateTaskRequest,
    ipAddress: string,
  ): Promise<TaskResponse> {
    const save = saveOf(request);

    if (!isManager(actor.role)) {
      const assignee =
        save.assignedToId === undefined
          ? null
          : await tx.staff.findUnique({
              where: { id: save.assignedToId },
              select: { id: true, role: true },
            });

      if (!mayRaiseTo(actor, assignee)) {
        throw new ForbiddenException(RAISE_TO_MESSAGE);
      }
    }

    const links = linksFor(actor, null, save);

    await this.checkLinks(tx, save.type, links, null);

    const assignedToId = await this.checkAssignee(tx, save.assignedToId);
    const row = await tx.task.create({
      data: {
        number: await drawNumber(tx, 'task'),
        title: save.title,
        type: save.type,
        assignedToId,
        raisedById: actor.id,
        status: request.status,
        purchaseId: links.purchaseId,
        maintenanceId: links.maintenanceId,
      },
      select: TASK_COLUMNS,
    });

    await tx.taskHistory.create({
      data: { taskId: row.id, status: row.status, staffId: actor.id },
    });

    const answer = await this.answer(tx, row);

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'task.save',
        ref: row.number,
        after: auditFields(answer),
        ipAddress,
      },
      tx,
    );

    return answer;
  }

  /**
   * `task.save` on a task that exists, in the demo's order: a non-manager
   * must be its assignee and may change only its status (403, the demo's
   * sentences); a manager's save is checked like a new task's, except that
   * the task keeps a link to a record that has since closed. Every save
   * adds a history row, the status unchanged included, as in the demo.
   */
  async update(
    actor: StaffPrincipal,
    id: string,
    request: UpdateTaskRequest,
    ipAddress: string,
  ): Promise<TaskResponse> {
    return this.prisma.$transaction(async (tx) => {
      await claimVersion(tx, {
        table: 'Task',
        id,
        version: request.version,
        notFound: TASK_NOT_FOUND_MESSAGE,
      });

      const current = await tx.task.findUniqueOrThrow({
        where: { id },
        select: TASK_COLUMNS,
      });
      const save = saveOf(request);
      const problem = nonManagerSaveProblem(actor, current, save);

      if (problem !== null) throw new ForbiddenException(problem);

      const before = await this.answer(tx, current);
      let data: Prisma.TaskUncheckedUpdateInput = { status: request.status };

      if (isManager(actor.role)) {
        const links = linksFor(actor, current, save);

        await this.checkLinks(tx, save.type, links, current);

        data = {
          ...data,
          title: save.title,
          type: save.type,
          assignedToId: await this.checkAssignee(tx, save.assignedToId),
          purchaseId: links.purchaseId,
          maintenanceId: links.maintenanceId,
        };
      }

      const updated = await tx.task.update({
        where: { id },
        data,
        select: TASK_COLUMNS,
      });

      await tx.taskHistory.create({
        data: { taskId: id, status: updated.status, staffId: actor.id },
      });

      const answer = await this.answer(tx, updated);

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'task.save',
          ref: current.number,
          before: auditFields(before),
          after: auditFields(answer),
          ipAddress,
        },
        tx,
      );

      return answer;
    });
  }

  /**
   * The demo's link checks: a Maintenance task needs a repair that is not
   * Fixed or Not Fixed, a Purchase task a requisition that is not
   * Fulfilled, Rejected or Cancelled (`isClosedPurchase`, so not archived
   * either); the record a task already links passes even once closed.
   */
  private async checkLinks(
    tx: Tx,
    type: TaskType,
    links: TaskLinks,
    stored: StoredTask | null,
  ): Promise<void> {
    if (type === TaskType.MAINTENANCE) {
      const repair =
        links.maintenanceId === null
          ? null
          : await tx.maintenanceRecord.findUnique({
              where: { id: links.maintenanceId },
              select: { id: true, status: true },
            });
      const open =
        repair !== null &&
        (!CLOSED_REPAIRS.includes(repair.status) ||
          repair.id === stored?.maintenanceId);

      if (!open) throw new BadRequestException(OPEN_MAINTENANCE_MESSAGE);
    }

    if (type === TaskType.PURCHASE) {
      const purchase =
        links.purchaseId === null
          ? null
          : await tx.purchase.findUnique({
              where: { id: links.purchaseId },
              select: { id: true, status: true, archived: true },
            });
      const open =
        purchase !== null &&
        (!isClosedPurchase(purchase) || purchase.id === stored?.purchaseId);

      if (!open) throw new BadRequestException(OPEN_PURCHASE_MESSAGE);
    }
  }

  /**
   * The demo's assignee check: an active member of staff who is neither a
   * Waiter nor a Bartender (400). Returns their id.
   */
  private async checkAssignee(
    tx: Tx,
    assignedToId: string | undefined,
  ): Promise<string> {
    const assignee =
      assignedToId === undefined
        ? null
        : await tx.staff.findUnique({
            where: { id: assignedToId },
            select: { id: true, role: true, isActive: true },
          });

    if (assignee === null || !isAssignable(assignee)) {
      throw new BadRequestException(ASSIGNEE_MESSAGE);
    }

    return assignee.id;
  }

  private async answer(tx: Tx, row: TaskRow): Promise<TaskResponse> {
    const [answer] = await this.answerMany(tx, [row]);

    return answer;
  }

  /**
   * Tasks as the routes answer them. Their history, people, requisitions
   * and repairs are separate queries awaited in turn, never a nested
   * select, so this is safe inside a transaction (*Data and migrations*).
   */
  private async answerMany(
    client: Reader,
    rows: readonly TaskRow[],
  ): Promise<TaskResponse[]> {
    if (rows.length === 0) return [];

    const history = await client.taskHistory.findMany({
      where: { taskId: { in: rows.map((row) => row.id) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        taskId: true,
        status: true,
        staffId: true,
        automatic: true,
        createdAt: true,
      },
    });
    const peopleIds = new Set<string>();

    for (const row of rows) {
      peopleIds.add(row.assignedToId);
      peopleIds.add(row.raisedById);
    }

    for (const step of history) {
      if (step.staffId !== null) peopleIds.add(step.staffId);
    }

    const people = await client.staff.findMany({
      where: { id: { in: [...peopleIds] } },
      select: { id: true, name: true },
    });
    const purchaseIds = rows.flatMap((row) =>
      row.purchaseId === null ? [] : [row.purchaseId],
    );
    const repairIds = rows.flatMap((row) =>
      row.maintenanceId === null ? [] : [row.maintenanceId],
    );
    const purchases =
      purchaseIds.length === 0
        ? []
        : await client.purchase.findMany({
            where: { id: { in: purchaseIds } },
            select: { id: true, number: true },
          });
    const repairs =
      repairIds.length === 0
        ? []
        : await client.maintenanceRecord.findMany({
            where: { id: { in: repairIds } },
            select: { id: true, number: true },
          });
    const nameOf = new Map(people.map((person) => [person.id, person.name]));
    const purchaseNumber = new Map(purchases.map((p) => [p.id, p.number]));
    const repairNumber = new Map(repairs.map((r) => [r.id, r.number]));

    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      title: row.title,
      type: row.type,
      status: row.status,
      assignedToId: row.assignedToId,
      assignedToName: nameOf.get(row.assignedToId) ?? '',
      raisedById: row.raisedById,
      raisedByName: nameOf.get(row.raisedById) ?? '',
      automatic: row.automatic,
      purchaseId: row.purchaseId,
      purchaseNumber:
        row.purchaseId === null
          ? null
          : (purchaseNumber.get(row.purchaseId) ?? null),
      maintenanceId: row.maintenanceId,
      maintenanceNumber:
        row.maintenanceId === null
          ? null
          : (repairNumber.get(row.maintenanceId) ?? null),
      createdAt: row.createdAt.toISOString(),
      history: history
        .filter((step) => step.taskId === row.id)
        .map((step) => ({
          status: step.status,
          at: step.createdAt.toISOString(),
          staffId: step.staffId,
          staffName:
            step.staffId === null ? null : (nameOf.get(step.staffId) ?? null),
          automatic: step.automatic,
        })),
      version: row.version,
    }));
  }
}

/** What an audit row says about a task: names and numbers, never ids. */
function auditFields(task: TaskResponse) {
  return {
    title: task.title,
    type: task.type,
    assignedTo: task.assignedToName,
    status: task.status,
    purchase: task.purchaseNumber,
    maintenance: task.maintenanceNumber,
  };
}
