import { Injectable, Logger } from '@nestjs/common';
import { ReservationStatus } from '../../generated/cnc-client';
import { addDays } from '../common/calendar-date';
import { watToday } from '../common/wat';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { ReservationMail } from './reservation-mail';
import { reminderDue } from './reservation-rules';

/** How many reminders one sweep run sends at most, soonest booking first. */
export const REMINDER_SWEEP_BATCH = 100;

/** What one run of the reminders sweep did. */
export interface RemindersSweepResult {
  /** Bookings whose reminder fell due and was handled this run. */
  reminded: number;
  /** Of those, how many were emailed. */
  emailed: number;
  /**
   * Of those, how many were not emailed because the booking's customer
   * switched Reservation Reminders off (their in-app list still has it).
   */
  switchedOff: number;
}

/**
 * The booking reminders (Q32's default; card C6-8), sent by
 * `POST /internal/sweeps/reminders` every 15 minutes:
 *
 * - **24 hours before** the booking (`REMINDER_LEAD_MS`), once its time
 *   is inside that day and the booking has not started;
 * - **none for a booking made, or moved, less than 24 hours ahead**: the
 *   booking command stamps `reminderSentAt` then (`initialReminderStamp`),
 *   so the sweep passes it by;
 * - **guests get one** by email, whatever channel booked them;
 * - **a customer who switched Reservation Reminders off**
 *   (`prefBookingReminders`) gets no email; the item still goes to their
 *   in-app list, which is a history, not a message.
 *
 * Only Confirmed bookings are reminded. Each is claimed by one conditional
 * update (`reminderSentAt IS NULL`, still Confirmed) inside the
 * transaction that queues its messages, so two sweeps at once remind a
 * booking once, and a booking cancelled first is not reminded. The email
 * goes through the outbound queue like every other, sent after the commit
 * and retried by the messages sweep.
 */
@Injectable()
export class ReservationRemindersService {
  private readonly logger = new Logger(ReservationRemindersService.name);

  constructor(
    private readonly prisma: CncPrismaService,
    private readonly mail: ReservationMail,
  ) {}

  async sweep(now: Date): Promise<RemindersSweepResult> {
    const result: RemindersSweepResult = {
      reminded: 0,
      emailed: 0,
      switchedOff: 0,
    };
    const today = watToday(now);

    // A booking due a reminder starts within the next 24 hours: today or
    // tomorrow in Jos. The rule itself is `reminderDue`.
    const candidates = await this.prisma.reservation.findMany({
      where: {
        status: ReservationStatus.CONFIRMED,
        reminderSentAt: null,
        businessDate: { gte: today, lte: addDays(today, 1) },
      },
      orderBy: [{ businessDate: 'asc' }, { startMinutes: 'asc' }],
      select: { id: true, businessDate: true, startMinutes: true },
    });
    const due = candidates
      .filter((row) => reminderDue(row.businessDate, row.startMinutes, now))
      .slice(0, REMINDER_SWEEP_BATCH);

    for (const { id } of due) {
      try {
        const outcome = await this.remind(id, now);

        if (outcome === 'skipped') continue;

        result.reminded += 1;
        if (outcome === 'emailed') result.emailed += 1;
        if (outcome === 'switched-off') result.switchedOff += 1;
      } catch (error) {
        // One booking's failure must not stop the rest; it is still
        // unclaimed, so the next run tries it again.
        this.logger.error(
          `The reminder for reservation ${id} could not be written: ` +
            `${error instanceof Error ? error.name : 'unknown error'}.`,
        );
      }
    }

    return result;
  }

  private async remind(
    id: string,
    now: Date,
  ): Promise<'emailed' | 'switched-off' | 'in-app' | 'skipped'> {
    let mailKey: string | null = null;

    const outcome = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.reservation.updateMany({
        where: {
          id,
          status: ReservationStatus.CONFIRMED,
          reminderSentAt: null,
        },
        data: { reminderSentAt: now },
      });

      if (claimed.count !== 1) return 'skipped' as const;

      const row = await tx.reservation.findUniqueOrThrow({
        where: { id },
        select: { customer: { select: { prefBookingReminders: true } } },
      });
      const switchedOff = row.customer?.prefBookingReminders === false;

      mailKey = await this.mail.enqueue(tx, 'reminder', id, {
        email: !switchedOff,
      });

      if (switchedOff) return 'switched-off' as const;

      return mailKey === null ? ('in-app' as const) : ('emailed' as const);
    });

    // The email now; the reminder's push (C10, PC9) only queued, for the
    // push sweep (D14): a sweep run never waits on push services.
    await this.mail.dispatch(mailKey, { push: false });

    return outcome;
  }
}
