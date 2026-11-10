import { Injectable } from '@nestjs/common';
import { type Prisma, ReservationSource } from '../../generated/cnc-client';
import { CncConfigService } from '../config/cnc.config';
import { bookingNotification } from '../customer-notifications/customer-notification-texts';
import { CustomerNotificationsService } from '../customer-notifications/customer-notifications.service';
import { cncPhoneForMail, firstName } from '../mail/mail-contact';
import type { MailTemplateName } from '../mail/mail-templates';
import { OutboundMessagesService } from '../mail/outbound-messages.service';
import type { BookingInput, CustomerPushEvent } from '../push/push-catalogue';
import { asId, watDateLabel, watTimeLabel } from '../push/push-input-types';
import { PushQueueService, type PushTopics } from '../push/push-queue.service';
import { bookingDateText, bookingStart, clockText } from './reservation-rules';

type Tx = Prisma.TransactionClient;

/** Which booking message. */
export type ReservationMailKind =
  'confirmed' | 'changed' | 'cancelled' | 'reminder';

/** How `enqueue` writes a message. */
export interface ReservationMailOptions {
  /** False to queue no email (a reminder the customer switched off). */
  email?: boolean;
  /**
   * Staff made this change or cancellation, so the customer's devices are
   * told (C10, PC7 and PC8). A customer's own change pushes nothing: they
   * made it on screen.
   */
  byStaff?: boolean;
}

/** The customer events a booking message may push. */
type BookingPushEvent = Extract<CustomerPushEvent, `reservation.${string}`>;

/**
 * Which push a booking message carries to its customer (C10): a booking
 * Reception made for them (PC6), a change or cancellation staff made
 * (PC7, PC8), and the reminder (PC9, behind Reservation Reminders). A
 * booking or change the customer made themselves pushes nothing.
 */
export function bookingPushEvent(
  kind: ReservationMailKind,
  source: ReservationSource,
  byStaff: boolean,
): BookingPushEvent | null {
  switch (kind) {
    case 'confirmed':
      return source === ReservationSource.RECEPTION
        ? 'reservation.booked_for_you'
        : null;
    case 'changed':
      return byStaff ? 'reservation.changed_by_staff' : null;
    case 'cancelled':
      return byStaff ? 'reservation.cancelled_by_staff' : null;
    case 'reminder':
      return 'reservation.reminder';
  }
}

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
 *
 * **Web push (C10).** The item may carry a push to the customer's devices
 * (`bookingPushEvent`), queued with it under the same key, so `dispatch`
 * sends the email and the push together. The reminder's push is never
 * dispatched here: the reminders sweep only queues it, and the push sweep
 * sends it (D14).
 */
@Injectable()
export class ReservationMail {
  constructor(
    private readonly outbound: OutboundMessagesService,
    private readonly notifications: CustomerNotificationsService,
    private readonly config: CncConfigService,
    private readonly push: PushQueueService,
  ) {}

  /**
   * Write the messages for `kind` about the booking as it now stands, and
   * return the dedupe key for `dispatch`: the email's, or, with no email,
   * the push's when one was queued (never a reminder's, which the push
   * sweep sends). Null when nothing waits to be sent now: no email (the
   * booking has none, an anonymised one (Q36), or the caller said
   * `email: false`) and no push.
   */
  async enqueue(
    tx: Tx,
    kind: ReservationMailKind,
    reservationId: string,
    options: ReservationMailOptions = {},
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
        source: true,
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

    let pushed: string | null = null;

    if (row.customerId !== null) {
      const event = bookingPushEvent(
        kind,
        row.source,
        options.byStaff === true,
      );

      pushed = await this.notifications.record(
        tx,
        row.customerId,
        bookingNotification(kind, {
          tableName: table.name,
          venueTitle: venue.customerTitle,
          businessDate: row.businessDate,
          startMinutes: row.startMinutes,
        }),
        dedupeKey,
        event === null
          ? null
          : {
              event,
              input: (): BookingInput => ({
                reservationId: asId(row.id),
                version: row.version,
                date: watDateLabel(row.businessDate),
                time: watTimeLabel(row.startMinutes),
                startsAt: bookingStart(row.businessDate, row.startMinutes),
              }),
            },
      );
    }

    // A reminder's push waits for the push sweep (D14).
    const pushNow = pushed !== null && kind !== 'reminder' ? dedupeKey : null;

    if (row.email === '' || options.email === false) return pushNow;

    await this.outbound.enqueue(tx, {
      to: row.email,
      template: TEMPLATE[kind],
      params: {
        number: row.number,
        guestName: firstName(row.name),
        venue: venue.customerTitle,
        table: table.name,
        date: bookingDateText(row.businessDate),
        time: clockText(row.startMinutes),
        party: row.party,
        // Stored as digits; shown as the site shows it (Q6).
        phone: await cncPhoneForMail(tx),
        accountUrl: this.config.buildWebUrl('/account') ?? null,
      },
      dedupeKey,
    });

    return dedupeKey;
  }

  /**
   * Send a queued booking email after the commit, then the push queued
   * under its key (the push's topic is the key) and `alsoPush`, the
   * command's other pushes, under one deadline (D14). `push: false` sends
   * the email only: the reminders sweep, whose pushes the push sweep
   * sends. Never throws.
   */
  async dispatch(
    dedupeKey: string | null,
    options: { push?: boolean; alsoPush?: PushTopics } = {},
  ): Promise<void> {
    if (dedupeKey !== null) await this.outbound.dispatchByKey(dedupeKey);

    if (options.push === false) return;

    await this.push.dispatchTopics([dedupeKey, ...(options.alsoPush ?? [])]);
  }
}
