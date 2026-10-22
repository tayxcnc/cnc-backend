import { TaskStatus } from '../../generated/cnc-client';
import type { StaffBellItem } from '../reception/free-table-reminder';

/** The staff app's words for a task's status. */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  [TaskStatus.OPEN]: 'Open',
  [TaskStatus.IN_PROGRESS]: 'In Progress',
  [TaskStatus.DONE]: 'Done',
};

/**
 * The demo's assigned-task bell item (`staff/lib/notifications.ts`): "Assigned
 * Task · Open", the task's title, on the Tasks page. Every task assigned to
 * the reader that is not Done shows one, the automatic ones included, which
 * is how the receive task reaches the Storekeeper (the C5 gate's step 2).
 */
export function assignedTaskItem(task: {
  id: string;
  title: string;
  status: TaskStatus;
}): StaffBellItem {
  return {
    id: `task:${task.id}`,
    title: `Assigned Task · ${TASK_STATUS_LABELS[task.status]}`,
    detail: task.title,
    page: 'tasks',
    category: 'Task',
  };
}
