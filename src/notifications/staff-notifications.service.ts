import { Injectable } from '@nestjs/common';
import { StaffRole } from '../../generated/cnc-client';
import type { StaffPrincipal } from '../auth/staff-principal';
import { isManager } from '../auth/staff-roles';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type PaginationQuery,
} from '../common/dto/pagination.query';
import type { StaffBellItem } from '../reception/free-table-reminder';
import { TableSessionsService } from '../reception/table-sessions.service';

/**
 * The staff bell (plan §9.1), computed on read and polled by the staff app
 * (A20). It ports `staff/lib/notifications.ts` one item at a time, as the
 * records each item reads are built: today the Free Table Reminder (card
 * C4-7; the C4 gate's step 11), for Reception and managers with no alert
 * switch, as in the demo. Card C8-2 adds the other items here, each with
 * its own roles and alert switch.
 */
@Injectable()
export class StaffNotificationsService {
  constructor(private readonly tables: TableSessionsService) {}

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

    return {
      data: items.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: items.length,
    };
  }
}
