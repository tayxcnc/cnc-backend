import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '../../generated/cnc-client';
import { ACCOUNT_GONE_MESSAGE } from '../auth/guards/cnc-staff.guard';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type PaginationQuery,
} from '../common/dto/pagination.query';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import type { NotificationText } from './customer-notification-texts';
import type {
  CustomerNotificationPageResponse,
  NotificationsReadResponse,
} from './dto/customer-notification.dto';

/** A Prisma client or a transaction's, for `record`. */
type NotificationWriter = Pick<
  Prisma.TransactionClient,
  'customer' | 'customerNotification'
>;

/**
 * The customer's in-app list (plan §4.8, §9.2; card C6-8): written by the
 * same events that send email, in the event's own transaction, and read by
 * `GET /me/notifications`.
 *
 * - `record(tx, …)` writes one item. Its `dedupeKey` (the email's, where
 *   there is one) makes an event write at most one item however often it
 *   runs: inserted with `ON CONFLICT DO NOTHING`, so a repeat neither
 *   duplicates nor aborts the caller's transaction. A deleted account
 *   (Q36) gets nothing.
 * - The list is a history, not a preference: what a customer switched off
 *   by email still appears here, because nothing here interrupts anyone.
 * - What is unread is what was created after `Customer.notificationsReadAt`
 *   (plan §4.2); `markRead` moves that instant to the server's now (A11),
 *   never backwards.
 */
@Injectable()
export class CustomerNotificationsService {
  constructor(private readonly prisma: CncPrismaService) {}

  /** Write one item for the customer, in the caller's transaction. */
  async record(
    tx: NotificationWriter,
    customerId: string,
    text: NotificationText,
    dedupeKey: string,
  ): Promise<void> {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: { deletedAt: true },
    });

    if (customer === null || customer.deletedAt !== null) return;

    await tx.customerNotification.createMany({
      data: [
        {
          // The server's clock (A11), the one `markRead` stamps
          // `notificationsReadAt` with, so "created after it" compares
          // two readings of one clock.
          createdAt: new Date(),
          customerId,
          kind: text.kind,
          title: text.title,
          body: text.body,
          link: text.link,
          dedupeKey,
        },
      ],
      skipDuplicates: true,
    });
  }

  /** `GET /me/notifications`: newest first, with what is unread. */
  async list(
    customerId: string,
    query: PaginationQuery,
  ): Promise<CustomerNotificationPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const readAt = await this.readAt(customerId);
    const where = { customerId };
    const unreadWhere =
      readAt === null ? where : { customerId, createdAt: { gt: readAt } };

    const [rows, total, unread] = await Promise.all([
      this.prisma.customerNotification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          createdAt: true,
          kind: true,
          title: true,
          body: true,
          link: true,
        },
      }),
      this.prisma.customerNotification.count({ where }),
      this.prisma.customerNotification.count({ where: unreadWhere }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        at: row.createdAt.toISOString(),
        kind: row.kind,
        title: row.title,
        body: row.body,
        link: row.link,
        unread: readAt === null || row.createdAt > readAt,
      })),
      page,
      pageSize,
      total,
      unread,
      notificationsReadAt: readAt?.toISOString() ?? null,
    };
  }

  /**
   * `POST /me/notifications/read`: everything up to now is read. The
   * instant is the server's (A11), and a later instant already stored (a
   * second device's tap a moment before) is kept, so it never moves back.
   */
  async markRead(customerId: string): Promise<NotificationsReadResponse> {
    const now = new Date();

    await this.prisma.customer.updateMany({
      where: {
        id: customerId,
        deletedAt: null,
        OR: [
          { notificationsReadAt: null },
          { notificationsReadAt: { lt: now } },
        ],
      },
      data: { notificationsReadAt: now },
    });

    const readAt = await this.readAt(customerId);

    return { notificationsReadAt: readAt?.toISOString() ?? now.toISOString() };
  }

  private async readAt(customerId: string): Promise<Date | null> {
    const row = await this.prisma.customer.findFirst({
      where: { id: customerId, deletedAt: null },
      select: { notificationsReadAt: true },
    });

    if (row === null) throw new UnauthorizedException(ACCOUNT_GONE_MESSAGE);

    return row.notificationsReadAt;
  }
}
