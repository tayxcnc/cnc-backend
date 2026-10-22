/**
 * The task sentences, byte for byte from the demo's `task.save`
 * (`staff/lib/domain.ts`, A7). The screens show them as they stand.
 * Sentences marked new have no demo original.
 */

/** A non-manager raising a task to anyone but a manager or themselves (403). */
export const RAISE_TO_MESSAGE = 'Raise a task to a manager, or to yourself.';

/** A non-manager updating a task not assigned to them (403). */
export const ASSIGNED_ONLY_MESSAGE =
  'Only the assigned staff member or a manager can update this task.';

/** A non-manager changing a task's description (403). */
export const MANAGER_DETAILS_MESSAGE =
  'Only a manager can change task details.';

/** A non-manager reassigning a task (403). */
export const MANAGER_REASSIGN_MESSAGE = 'Only a manager can reassign tasks.';

/** A non-manager changing a task's type or the record it links to (403). */
export const MANAGER_LINKS_MESSAGE =
  'Only a manager can change task links or type.';

/** A blank description. */
export const TASK_TITLE_MESSAGE = 'Enter a task description.';

/** A type that is not General, Maintenance or Purchase. */
export const TASK_TYPE_MESSAGE = 'Select a task type.';

/** A status that is not Open, In Progress or Done. */
export const TASK_STATUS_MESSAGE = 'Invalid task status.';

/** A Maintenance task without a repair that is still open. */
export const OPEN_MAINTENANCE_MESSAGE = 'Choose an open maintenance record.';

/** A Purchase task without a requisition that is still open. */
export const OPEN_PURCHASE_MESSAGE = 'Choose an open purchase requisition.';

/** An assignee who is missing, inactive, a Waiter or a Bartender. */
export const ASSIGNEE_MESSAGE =
  'Choose an active staff member. Waiters and bartenders report to their supervisors and are not assigned tasks.';

/**
 * A task id that names nothing (404). New: the demo saved an unknown id as
 * a new task; the server's update names a task, and its version claim needs
 * one not-found sentence, in the form of "Purchase not found.".
 */
export const TASK_NOT_FOUND_MESSAGE = 'Task not found.';

/** A tasks filter naming an unknown status (400). New. */
export const TASK_STATUS_FILTER_MESSAGE = 'Choose a task status.';

/** Longest task description; new (the demo has none). */
export const TASK_TITLE_MAX_LENGTH = 200;
