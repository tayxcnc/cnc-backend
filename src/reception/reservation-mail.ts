import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/cnc-client';
import { CncConfigService } from '../config/cnc.config';
import { bookingNotification } from '../customer-notifications/customer-notification-texts';
import { CustomerNotificationsService } from '../customer-notifications/customer-notifications.service';
import type { MailTemplateName } from '../mail/mail-templates';
import { OutboundMessagesService } from '../mail/outbound-messages.service';
import { bookingDateText, clockText } from './reservation-rules';

type Tx = Prisma.TransactionClient;

/** Which booking message. */
export type ReservationMailKind =
  'confirmed' | 'changed' | 'cancelled' | 'reminder';

const TEMPLATE: Record<ReservationMailKind, MailTemplateName> = {
  confirmed: 'reservation.confirmed',
  changed: 'reservation.changed',
  cancelled: 'reservation.cancelled',
  reminder: 'reservation.reminder',
};

/**
 * The guest's booking messages (plan §9.2): the confirmation for every
 * booking, whatever its channel, the change and cancellation notices, and
 * the reminder (Q32, written by `ReservationRemindersService`). Each is an
 * email to the address on the booking and, when the booking belongs to a
 * customer, an item in their in-app list (card C6-8: "written by the same
 * events"). Confirmations always go to the email given (Q31's default);
 * only the reminder's email answers to a preference, and the caller
 * decides that (`email: false`).
 *
 * Queued in the command's transaction (`enqueue`, after the booking row is
 * written, so the message says what was committed) and the email sent
 * after the commit (`dispatch`). Each event writes at most one email and
 * one item: the dedupe key is the booking and the event, and a change's
 * and a reminder's carry the booking's `version`, so two changes are two
 * messages and a replay is none. The in-app item shares the email's key.
 */
@Injectable()
export class ReservationMail {
  constructor(
    private readonly outbound: OutboundMessagesService,
    private readonly notifications: CustomerNotificationsService,
    private readonly config: CncConfigService,
  ) {}

  /**
   * Write the messages for `kind` about the booking as it now stands, and
   * return the email's dedupe key for `dispatch`; null when no email was
   * queued (the booking has no email, an anonymised one (Q36), or the
   * caller said `email: false`).
   */
  async enqueue(
    tx: Tx,
    kind: ReservationMailKind,
    reservationId: string,
    options: { email?: boolean } = {},
  ): Promise<string | null> {
    const row = await tx.reservation.findUniqueOrThrow({
      where: { id: reservationId },
      select: {
        id: true,
        number: true,
        tableId: true,
        customerId: true,
        name: true,
        email: true,
        businessDate: true,
        startMinutes: true,
        party: true,
        version: true,
      },
    });
    const table = await tx.diningTable.findUniqueOrThrow({
      where: { id: row.tableId },
      select: { name: true, venueId: true },
    });
    const venue = await tx.venue.findUniqueOrThrow({
      where: { id: table.venueId },
      select: { customerTitle: true },
    });
    // A change, and the reminder, carry the version: a booking moved after
    // its reminder went gets a reminder for the new time too.
    const dedupeKey =
      kind === 'changed' || kind === 'reminder'
        ? `reservation:${row.id}:${kind}:${row.version}`
        : `reservation:${row.id}:${kind}`;

    if (row.customerId !== null) {
      await this.notifications.record(
        tx,
        row.customerId,
        bookingNotification(kind, {
          tableName: table.name,
          venueTitle: venue.customerTitle,
          businessDate: row.businessDate,
          startMinutes: row.startMinutes,
        }),
        dedupeKey,
      );
    }

    if (row.email === '' || options.email === false) return null;

    const business = await tx.business.findUnique({
      where: { singleton: true },
      select: { phone: true },
    });

    await this.outbound.enqueue(tx, {
      to: row.email,
      template: TEMPLATE[kind],
      params: {
        number: row.number,
        guestName: row.name.trim().split(/\s+/)[0] || row.name,
        venue: venue.customerTitle,
        table: table.name,
        date: bookingDateText(row.businessDate),
        time: clockText(row.startMinutes),
        party: row.party,
        phone: business?.phone || 'the number on our website',
        accountUrl: this.config.buildWebUrl('/account') ?? null,
      },
      dedupeKey,
    });

    return dedupeKey;
  }

  /** Send a queued booking email after the commit. Never throws. */
  async dispatch(dedupeKey: string | null): Promise<void> {
    if (dedupeKey !== null) await this.outbound.dispatchByKey(dedupeKey);
  }
}
