import { type Prisma, TaskStatus } from '../../generated/cnc-client';
import { asId } from '../push/push-input-types';
import type { PushQueueService, PushTopics } from '../push/push-queue.service';
import { isPurchaseReviewTask } from './assigned-task-item';

/** A task as its assignee's push needs it, once written. */
export interface AssignedTask {
  id: string;
  version: number;
  title: string;
  status: TaskStatus;
  assignedToId: string;
  purchaseId: string | null;
}

/** Where a command's task pushes go: the queue and the request's topics. */
export interface TaskPushes {
  queue: PushQueueService;
  topics: PushTopics;
}

/**
 * Tell a task's assignee it is theirs (C10, PS9): a task raised for them,
 * by a person (`task.save`) or by a command (`raiseAutomaticTask`), or one
 * reassigned to them. The words are constant ("New task assigned to you"):
 * a task's title is free text and names vendors and assets.
 *
 * Not sent:
 * - to whoever assigned it (the actor);
 * - for a Done task, which asks nothing of anyone;
 * - for a purchase's review task while the approvals alert is on
 *   (`isPurchaseReviewTask`, the bell's rule): the Purchase Approval push
 *   (PS5) already asks for the same decision.
 *
 * In the command's transaction; the topic joins `pushes.topics` for the
 * command to dispatch after its commit.
 */
export async function queueTaskAssigned(
  pushes: TaskPushes,
  tx: Prisma.TransactionClient,
  task: AssignedTask,
  actorId: string,
): Promise<void> {
  if (task.status === TaskStatus.DONE || task.assignedToId === actorId) return;

  if (isPurchaseReviewTask(task)) {
    const settings = await tx.settings.findUnique({
      where: { singleton: true },
      select: { alertApprovals: true },
    });

    if (settings?.alertApprovals !== false) return;
  }

  pushes.topics.push(
    await pushes.queue.enqueueStaff(
      tx,
      'task.assigned',
      () => ({ taskId: asId(task.id), version: task.version }),
      { staffIds: [task.assignedToId], except: [actorId] },
    ),
  );
}
