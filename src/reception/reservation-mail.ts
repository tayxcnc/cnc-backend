import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/cnc-client';
import { CncConfigService } from '../config/cnc.config';
import type { MailTemplateName } from '../mail/mail-templates';
import { OutboundMessagesService } from '../mail/outbound-messages.service';
import { clockText } from './reservation-rules';

type Tx = Prisma.TransactionClient;

/** Which booking email. */
export type ReservationMailKind = 'confirmed' | 'changed' | 'cancelled';

const TEMPLATE: Record<ReservationMailKind, MailTemplateName> = {
  confirmed: 'reservation.confirmed',
  changed: 'reservation.changed',
  cancelled: 'reservation.cancelled',
};

/**
 * A booking date as the website writes it (`lib/booking/engine.ts`
 * `dateText`): "Sat 24 Oct 2026". The date is a `@db.Date` (UTC midnight),
 * so it is formatted in UTC, never shifted a day.
 */
export function bookingDateText(businessDate: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
    .format(businessDate)
    .replace(/,/g, '');
}

/**
 * The guest's booking emails (plan §9.2): the confirmation for every
 * booking, whatever its channel, and the change and cancellation notices.
 * Confirmations always go to the email given (Q31's default); they are not
 * switched off by a preference.
 *
 * Queued in the command's transaction (`enqueue`, after the booking row is
 * written, so the email says what was committed) and sent after the commit
 * (`dispatch`). Each event queues at most one message: its dedupe key is
 * the booking and the event, and a change's carries the booking's new
 * `version`, so two changes are two emails and a replay is none.
 */
@Injectable()
export class ReservationMail {
  constructor(
    private readonly outbound: OutboundMessagesService,
    private readonly config: CncConfigService,
  ) {}

  /**
   * Queue the email for `kind` about the booking as it now stands, and
   * return its dedupe key for `dispatch`; null when the booking has no
   * email (an anonymised one, Q36).
   */
  async enqueue(
    tx: Tx,
    kind: ReservationMailKind,
    reservationId: string,
  ): Promise<string | null> {
    const row = await tx.reservation.findUniqueOrThrow({
      where: { id: reservationId },
      select: {
        id: true,
        number: true,
        tableId: true,
        name: true,
        email: true,
        businessDate: true,
        startMinutes: true,
        party: true,
        version: true,
      },
    });

    if (row.email === '') return null;

    const table = await tx.diningTable.findUniqueOrThrow({
      where: { id: row.tableId },
      select: { name: true, venueId: true },
    });
    const venue = await tx.venue.findUniqueOrThrow({
      where: { id: table.venueId },
      select: { customerTitle: true },
    });
    const business = await tx.business.findUnique({
      where: { singleton: true },
      select: { phone: true },
    });
    const dedupeKey =
      kind === 'changed'
        ? `reservation:${row.id}:changed:${row.version}`
        : `reservation:${row.id}:${kind}`;

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
