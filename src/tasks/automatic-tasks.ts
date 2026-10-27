import {
  type Prisma,
  StaffRole,
  TaskStatus,
  type TaskType,
} from '../../generated/cnc-client';
import { drawNumber } from '../prisma/sequences';

/**
 * The tasks a command raises and closes by itself (plan §7.7, §7.9): the
 * demo's `autoTask`, `closeTasks`, `managerName` and `storeName`
 * (`staff/lib/domain.ts`), on the server.
 *
 * "Follow up work is raised as tasks so nothing waits on memory: purchases
 * and repairs go to the manager, approved purchases go back to the
 * storekeeper to receive. The task closes when the work is done." Purchases
 * use these from C5-3, repairs from C5-6; `task.save` (C5-5) is the person's
 * own command and is not here.
 *
 * Every function takes the command's transaction client and runs inside it,
 * so a task is raised or closed with the command that caused it, or not at
 * all. Each query is awaited in turn (*Data and migrations*).
 */

type Tx = Prisma.TransactionClient;

/** The first active account with `role`, in the order accounts were made. */
async function firstActive(
  tx: Tx,
  role: StaffRole,
): Promise<string | undefined> {
  const row = await tx.staff.findFirst({
    where: { role, isActive: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });

  return row?.id;
}

/**
 * Who a purchase review or a repair follow-up goes to: the demo's
 * `managerName`. The first active Manager; with none, the first active
 * Owner (the Owner holds every manager permission); with neither, the
 * person whose command raised it. "First" is the order the accounts were
 * made in, as the demo's staff list is.
 */
export async function managerForTask(
  tx: Tx,
  fallbackStaffId: string,
): Promise<string> {
  return (
    (await firstActive(tx, StaffRole.MANAGER)) ??
    (await firstActive(tx, StaffRole.OWNER)) ??
    fallbackStaffId
  );
}

/**
 * Who receives an approved purchase: the demo's `storeName`. The first
 * active Storekeeper; with none, whoever {@link managerForTask} names.
 */
export async function storekeeperForTask(
  tx: Tx,
  fallbackStaffId: string,
): Promise<string> {
  return (
    (await firstActive(tx, StaffRole.STOREKEEPER)) ??
    (await managerForTask(tx, fallbackStaffId))
  );
}

/** One task a command raises by itself. */
export interface AutomaticTask {
  title: string;
  type: TaskType;
  assignedToId: string;
  /** The person whose command raised it (the demo's "<name> (automatic)"). */
  raisedById: string;
  /** Set only on a Purchase task (`Task_values_check`). */
  purchaseId?: string;
  /** Set only on a Maintenance task (`Task_values_check`). */
  maintenanceId?: string;
}

/**
 * The demo's `autoTask`: an Open task, marked automatic, with its first
 * history entry (Open, automatic, by the person whose command raised it).
 * Returns the task's number (`T-000001`).
 */
export async function raiseAutomaticTask(
  tx: Tx,
  task: AutomaticTask,
): Promise<string> {
  const number = await drawNumber(tx, 'task');
  const created = await tx.task.create({
    data: {
      number,
      title: task.title,
      type: task.type,
      assignedToId: task.assignedToId,
      raisedById: task.raisedById,
      status: TaskStatus.OPEN,
      purchaseId: task.purchaseId ?? null,
      maintenanceId: task.maintenanceId ?? null,
      automatic: true,
    },
    select: { id: true },
  });

  await tx.taskHistory.create({
    data: {
      taskId: created.id,
      status: TaskStatus.OPEN,
      staffId: task.raisedById,
      automatic: true,
    },
  });

  return number;
}

/** Which open tasks {@link closeOpenTasks} closes. */
export interface TasksToClose {
  purchaseId?: string;
  maintenanceId?: string;
  /**
   * True to close only the tasks a command raised by itself (a purchase's
   * review or receive task as its status moves on); false to close every
   * open task on the record, as receiving and archiving do.
   */
  automaticOnly: boolean;
}

/**
 * The demo's `closeTasks`: every matching task that is not Done becomes
 * Done, with an automatic history entry by the person whose command closed
 * it. One conditional update moves each task's `version`, so a person
 * saving the task from an older screen is refused as stale rather than
 * reopening it unseen. Returns how many were closed.
 */
export async function closeOpenTasks(
  tx: Tx,
  which: TasksToClose,
  staffId: string,
): Promise<number> {
  if (which.purchaseId === undefined && which.maintenanceId === undefined) {
    // An unscoped close would close every open task at CNC.
    throw new Error('closeOpenTasks needs a purchase or a repair.');
  }

  const closed = await tx.task.updateManyAndReturn({
    where: {
      ...(which.purchaseId !== undefined
        ? { purchaseId: which.purchaseId }
        : {}),
      ...(which.maintenanceId !== undefined
        ? { maintenanceId: which.maintenanceId }
        : {}),
      ...(which.automaticOnly ? { automatic: true } : {}),
      status: { not: TaskStatus.DONE },
    },
    data: { status: TaskStatus.DONE, version: { increment: 1 } },
    select: { id: true },
  });

  if (closed.length > 0) {
    await tx.taskHistory.createMany({
      data: closed.map((task) => ({
        taskId: task.id,
        status: TaskStatus.DONE,
        staffId,
        automatic: true,
      })),
    });
  }

  return closed.length;
}
