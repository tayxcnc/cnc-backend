import { type Prisma, StaffRole } from '../../generated/cnc-client';
import type { DocketResponse } from '../orders/dto/order.response';
import { asDocketRef, asOrderNumber } from '../push/push-input-types';
import type { PushQueueService } from '../push/push-queue.service';

/**
 * Tell the Kitchen's devices of a web docket (C10, PS2): the first one a
 * paid web order prints, and each revision a manager's edit or zone change
 * prints. Urgent, so never held: the food is paid for. The cancellation
 * docket (no items) pushes nothing, as it rings nothing in the bell.
 *
 * Shared by the placement (`OnlineOrderPlacementService`) and the staff
 * commands (`OnlineOrdersService`), in the transaction that wrote the
 * docket. Answers the topic, or null.
 */
export function queueWebDocketPush(
  push: PushQueueService,
  tx: Prisma.TransactionClient,
  docket: DocketResponse,
  except: string[],
): Promise<string | null> {
  if (docket.items.length === 0) return Promise.resolve(null);

  return push.enqueueStaff(
    tx,
    'docket.web',
    () => ({
      docketRef: asDocketRef(docket.ref),
      revision: docket.revision,
      orderNumber: asOrderNumber(docket.orderNumber),
      itemCount: docket.items.reduce((sum, item) => sum + item.qty, 0),
    }),
    { roles: [StaffRole.KITCHEN], except },
  );
}
