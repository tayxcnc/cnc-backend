import { ConflictException, Injectable } from '@nestjs/common';
import { ContactChannel, SubjectType } from '../../generated/cnc-client';
import { CncTokenService } from '../auth/cnc-token.service';
import { watToday } from '../common/wat';
import { PhotoStore } from '../images/photo-store.service';
import { idempotencyScope } from '../idempotency/idempotency-scope';
import { OutboundMessagesService } from '../mail/outbound-messages.service';
import { UNSETTLED_ORDER_STATUSES } from '../orders/order-rules';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { HOLDING_STATUSES } from '../reception/reservation-rules';
import { CustomerService } from './customer.service';

/**
 * An account with a booking still ahead, or a bill still open, cannot be
 * deleted yet (409). New: the demo had no deletion. Anonymising a booking
 * that is still to come would leave Reception a table held for nobody,
 * with no name to greet and no number to call.
 */
export const DELETE_WITH_UPCOMING_MESSAGE =
  'You have a reservation still to come or an order in progress. Cancel it, or wait until it is complete, then delete your account.';

/**
 * The name a deleted customer's bookings and bills show from then on.
 * Reception and the till still see that a booking or a bill existed.
 */
export const DELETED_CUSTOMER_NAME = 'Deleted customer';

/** `lastError` of a message given up because its account was deleted. */
export const ACCOUNT_DELETED_REASON = 'The account was deleted.';

/**
 * Deleting a customer's account (Q36's default: "customers can delete
 * their account from Profile, which anonymises their orders and
 * bookings").
 *
 * The row is kept, with `deletedAt` set: bookings, bills and the audit log
 * point at it, and money records are never deleted (plan §4). Everything
 * that identifies the person goes in one transaction:
 *
 * - the account's name, email, phone, address, photo and preferences
 *   (a CHECK refuses a deleted row that keeps a contact or an address);
 * - the name, phone, email and note on every booking, and the guest name
 *   on every bill, linked to it (their `version` moves, so a screen
 *   holding the old copy is told to refresh);
 * - the in-app notifications, the one-time codes sent to it or for it,
 *   and the stored answers of its idempotent requests;
 * - every session (all refresh tokens revoked; the guard refuses its
 *   access tokens at once), and every email still waiting to reach it.
 *
 * The photo object is removed after the commit. The audit log is
 * append-only by trigger and keeps what it recorded (A13).
 *
 * Refused while a booking still holds a table on a date from today on, or
 * a bill linked to the account is still open.
 */
@Injectable()
export class CustomerDeletionService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly customers: CustomerService,
    private readonly tokens: CncTokenService,
    private readonly outbound: OutboundMessagesService,
    private readonly photos: PhotoStore,
  ) {}

  async deleteAccount(customerId: string): Promise<void> {
    const now = new Date();

    const photo = await this.prisma.$transaction(async (tx) => {
      const current = await this.customers.lockLive(tx, customerId);

      const upcoming = await tx.reservation.count({
        where: {
          customerId,
          status: { in: HOLDING_STATUSES },
          businessDate: { gte: watToday(now) },
        },
      });
      const open = await tx.order.count({
        where: { customerId, status: { in: UNSETTLED_ORDER_STATUSES } },
      });

      if (upcoming > 0 || open > 0) {
        throw new ConflictException(DELETE_WITH_UPCOMING_MESSAGE);
      }

      await tx.reservation.updateMany({
        where: { customerId },
        data: {
          name: DELETED_CUSTOMER_NAME,
          phone: '',
          email: '',
          note: '',
          version: { increment: 1 },
        },
      });
      await tx.order.updateMany({
        where: { customerId, guest: { not: '' } },
        data: { guest: DELETED_CUSTOMER_NAME, version: { increment: 1 } },
      });

      await tx.customerNotification.deleteMany({ where: { customerId } });
      await tx.otpCode.deleteMany({
        where: {
          OR: [
            { customerId },
            ...(current.email === null ? [] : [{ contact: current.email }]),
          ],
        },
      });
      await tx.idempotencyKey.deleteMany({
        where: { scope: idempotencyScope.customer(customerId) },
      });

      if (current.email !== null) {
        await this.outbound.abandonTo(
          tx,
          current.email,
          ACCOUNT_DELETED_REASON,
        );
      }

      await this.tokens.revokeAllForSubject(
        customerId,
        SubjectType.CUSTOMER,
        tx,
      );

      await tx.customer.update({
        where: { id: customerId },
        data: {
          name: '',
          email: null,
          phone: null,
          emailVerifiedAt: null,
          phoneVerifiedAt: null,
          addressZone: null,
          addressStreet: null,
          addressArea: null,
          addressTown: null,
          addressLandmark: null,
          prefOrderUpdates: false,
          prefBookingReminders: false,
          prefOffers: false,
          prefChannel: ContactChannel.EMAIL,
          photo: null,
          notificationsReadAt: null,
          deletedAt: now,
        },
      });

      return current.photo;
    });

    await this.photos.removeQuietly(photo);
  }
}
