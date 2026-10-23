import { Injectable } from '@nestjs/common';
import {
  CheckoutStatus,
  StaffRole,
  TaskStatus,
} from '../../generated/cnc-client';
import type { StaffPrincipal } from '../auth/staff-principal';
import { isManager } from '../auth/staff-roles';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type PaginationQuery,
} from '../common/dto/pagination.query';
import {
  activeOnlineOrderItem,
  checkoutAttentionItem,
  newWebDocketItem,
} from '../online-orders/online-bell-items';
import { ACTIVE_ONLINE_STATUSES } from '../online-orders/online-order-rules';
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
 * last, as in the demo. From C7-7, the online orders' items, before the
 * reception items as in the demo: the Cashier's active online orders, the
 * Kitchen's and managers' New Web Docket, and the managers' Checkout Needs
 * Attention. Card C8-2 adds the other items here, each with its
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

    // C7-7, in the demo's order (online orders before the reception items).
    if (actor.role === StaffRole.CASHIER) {
      items.push(...(await this.activeOnlineOrders()));
    }

    if (isManager(actor.role) || actor.role === StaffRole.KITCHEN) {
      items.push(...(await this.newWebDockets()));
    }

    if (isManager(actor.role)) {
      items.push(...(await this.heldCheckouts()));
    }

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

  /**
   * The Cashier's active online orders (plan §9.1: not completed or
   * cancelled), oldest first: a paid web order appears as soon as its
   * payment writes it.
   */
  private async activeOnlineOrders(): Promise<StaffBellItem[]> {
    const rows = await this.prisma.onlineOrder.findMany({
      where: { fulfilmentStatus: { in: ACTIVE_ONLINE_STATUSES } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        contactName: true,
        fulfilmentStatus: true,
        order: { select: { number: true } },
      },
    });

    return rows.map((row) =>
      activeOnlineOrderItem({ ...row, orderNumber: row.order.number }),
    );
  }

  /**
   * Web dockets the kitchen has food to enter for (plan §9.1, New Web
   * Docket): the bill's current revision, with items, no kitchen entry
   * under its ref yet, on a kitchen day not closed. A closed day takes no
   * more entries, so its dockets would otherwise ring forever; a
   * cancellation docket has no items and rings nothing.
   */
  private async newWebDockets(): Promise<StaffBellItem[]> {
    const rows = await this.prisma.$queryRaw<
      { ref: string; revision: number; scheduledFor: Date | null }[]
    >`
      SELECT d."ref", d."revision", d."scheduledFor"
      FROM "Docket" d
      JOIN "Order" o ON o."id" = d."orderId" AND o."revision" = d."revision"
      WHERE d."channel" = 'WEB'
        AND jsonb_array_length(d."items") > 0
        AND NOT EXISTS (
          SELECT 1 FROM "KitchenEntry" k WHERE k."docketRef" = d."ref"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "KitchenDayClosed" c
          WHERE c."businessDate" = d."businessDate"
        )
      ORDER BY d."createdAt" ASC, d."id" ASC`;

    return rows.map(newWebDocketItem);
  }

  /** The managers' held checkouts (§7.4 step 3), oldest first. */
  private async heldCheckouts(): Promise<StaffBellItem[]> {
    const rows = await this.prisma.checkout.findMany({
      where: { status: CheckoutStatus.NEEDS_ATTENTION },
      orderBy: [{ attentionAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        contactName: true,
        totalKobo: true,
        attentionReason: true,
      },
    });

    return rows.map(checkoutAttentionItem);
  }
}
