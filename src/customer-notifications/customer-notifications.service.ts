import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '../../generated/cnc-client';
import { ACCOUNT_GONE_MESSAGE } from '../auth/guards/cnc-staff.guard';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type PaginationQuery,
} from '../common/dto/pagination.query';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import type {
  CustomerPushEvent,
  CustomerPushInputs,
} from '../push/push-catalogue';
import { type PushInput, PushQueueService } from '../push/push-queue.service';
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

/** The web push an item carries to the customer's devices (C10). */
export interface CustomerPushRequest<E extends CustomerPushEvent> {
  event: E;
  input: PushInput<CustomerPushInputs[E]>;
}

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
 * - **An item may carry a web push** (C10): `record`'s last argument names
 *   the catalogue's event, queued in the same transaction
 *   (`PushQueueService.enqueueCustomer`), which applies the customer's
 *   switch, so the list stays ungated (D62) while the push follows Order
 *   Updates or Reservation Reminders (D7). Only the events the catalogue
 *   names push: the caller decides which items do.
 */
@Injectable()
export class CustomerNotificationsService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly push: PushQueueService,
  ) {}

  /**
   * Write one item for the customer, in the caller's transaction, and queue
   * its push when `push` names one. Answers the push's topic, for the
   * caller to dispatch after the commit, or null when no push was queued
   * (none asked for, the switch off, no device, or a deleted account).
   */
  async record(
    tx: NotificationWriter,
    customerId: string,
    text: NotificationText,
    dedupeKey: string,
  ): Promise<null>;
  async record<E extends CustomerPushEvent>(
    tx: Prisma.TransactionClient,
    customerId: string,
    text: NotificationText,
    dedupeKey: string,
    push: CustomerPushRequest<E> | null,
  ): Promise<string | null>;
  async record<E extends CustomerPushEvent>(
    tx: NotificationWriter | Prisma.TransactionClient,
    customerId: string,
    text: NotificationText,
    dedupeKey: string,
    push: CustomerPushRequest<E> | null = null,
  ): Promise<string | null> {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: { deletedAt: true },
    });

    if (customer === null || customer.deletedAt !== null) return null;

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

    if (push === null) return null;

    // Only the second overload passes `push`, and it takes a transaction.
    return this.push.enqueueCustomer(
      tx as Prisma.TransactionClient,
      push.event,
      customerId,
      push.input,
    );
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
