import { type Prisma, StaffRole, TaskType } from '../../generated/cnc-client';
import { isManager } from '../auth/staff-roles';
import {
  ASSIGNED_ONLY_MESSAGE,
  MANAGER_DETAILS_MESSAGE,
  MANAGER_LINKS_MESSAGE,
  MANAGER_REASSIGN_MESSAGE,
} from './task-messages';

/**
 * The task rules (plan §4.7, §6.1, §6.2), pure, from the demo's `task.save`
 * and its Tasks screen (`staff/lib/domain.ts`,
 * `staff/components/cnc/records.tsx`), so each is unit-tested without a
 * database.
 */

/** Who is acting, by id (A10). */
export interface TaskActor {
  id: string;
  role: StaffRole;
}

/** The fields of a stored task the rules compare against. */
export interface StoredTask {
  title: string;
  type: TaskType;
  assignedToId: string;
  purchaseId: string | null;
  maintenanceId: string | null;
}

/** The fields of a save the rules read. */
export interface TaskSave {
  title: string;
  type: TaskType;
  assignedToId?: string;
  purchaseId?: string;
  maintenanceId?: string;
}

/**
 * The roles never given a task (plan §4.7): "Waiters and bartenders report
 * to their supervisors and are not assigned tasks."
 */
export const UNASSIGNABLE_ROLES: readonly StaffRole[] = [
  StaffRole.WAITER,
  StaffRole.BARTENDER,
];

/** Whether a person may hold a task: active, and neither a Waiter nor a Bartender. */
export function isAssignable(staff: {
  isActive: boolean;
  role: StaffRole;
}): boolean {
  return staff.isActive && !UNASSIGNABLE_ROLES.includes(staff.role);
}

/**
 * The demo's rule on a task a non-manager raises: to a manager (the Owner
 * included) or to themselves. A missing assignee fails it too, as in the
 * demo.
 */
export function mayRaiseTo(
  actor: TaskActor,
  assignee: { id: string; role: StaffRole } | null,
): boolean {
  return (
    assignee !== null && (isManager(assignee.role) || assignee.id === actor.id)
  );
}

/**
 * The demo's rules on a non-manager saving a task that exists, in its
 * order: only the assignee may save it, and only its status changes; a
 * description, assignee, type or link sent must be the task's own. Null
 * for a manager, or when the save keeps to the rules.
 */
export function nonManagerSaveProblem(
  actor: TaskActor,
  stored: StoredTask,
  save: TaskSave,
): string | null {
  if (isManager(actor.role)) return null;

  if (stored.assignedToId !== actor.id) return ASSIGNED_ONLY_MESSAGE;
  if (save.title !== stored.title) return MANAGER_DETAILS_MESSAGE;

  if (
    save.assignedToId !== undefined &&
    save.assignedToId !== stored.assignedToId
  ) {
    return MANAGER_REASSIGN_MESSAGE;
  }

  const sameLinks =
    save.type === stored.type &&
    (save.maintenanceId === undefined ||
      save.maintenanceId === stored.maintenanceId) &&
    (save.purchaseId === undefined || save.purchaseId === stored.purchaseId);

  return sameLinks ? null : MANAGER_LINKS_MESSAGE;
}

/** The records a task links to. */
export interface TaskLinks {
  purchaseId: string | null;
  maintenanceId: string | null;
}

/**
 * The demo's links on a save. A non-manager's save of an existing task
 * keeps its links. Otherwise the type decides: a Maintenance task links
 * the repair sent (or keeps its own), a Purchase task the requisition sent
 * (or keeps its own), and a General task links nothing; a link of the
 * other kind is dropped, as the demo drops it, so a task never links a
 * record its type does not name (`Task_values_check`).
 */
export function linksFor(
  actor: TaskActor,
  stored: StoredTask | null,
  save: TaskSave,
): TaskLinks {
  if (stored !== null && !isManager(actor.role)) {
    return {
      purchaseId: stored.purchaseId,
      maintenanceId: stored.maintenanceId,
    };
  }

  return {
    purchaseId:
      save.type === TaskType.PURCHASE
        ? (save.purchaseId ?? stored?.purchaseId ?? null)
        : null,
    maintenanceId:
      save.type === TaskType.MAINTENANCE
        ? (save.maintenanceId ?? stored?.maintenanceId ?? null)
        : null,
  };
}

/**
 * Which tasks a person sees (plan §6.1, the demo's Tasks screen): managers
 * every task; anyone else the tasks assigned to them and the ones they
 * raised themselves. A task a command raised by itself (a purchase's
 * review, a repair's follow-up) is not one the person raised: the demo
 * files it under "<name> (automatic)", so the Storekeeper does not see the
 * review of a purchase they asked for.
 */
export function visibleTasks(actor: TaskActor): Prisma.TaskWhereInput {
  if (isManager(actor.role)) return {};

  return {
    OR: [
      { assignedToId: actor.id },
      { raisedById: actor.id, automatic: false },
    ],
  };
}

/** Whether a person sees one task, by {@link visibleTasks}' rule. */
export function seesTask(
  actor: TaskActor,
  task: { assignedToId: string; raisedById: string; automatic: boolean },
): boolean {
  return (
    isManager(actor.role) ||
    task.assignedToId === actor.id ||
    (task.raisedById === actor.id && !task.automatic)
  );
}
