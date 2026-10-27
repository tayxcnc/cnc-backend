import { StaffRole } from '../../generated/cnc-client';
import { watMinutesOfDay } from '../common/wat';
import {
  expectedArrivalsWhere,
  unsettledBillsWhere,
} from '../notifications/bell-filters';
import type { CncPrismaService } from '../prisma/cnc-prisma.service';
import {
  asId,
  asTableName,
  watDay,
  watTimeLabel,
} from '../push/push-input-types';
import type { PushQueueService } from '../push/push-queue.service';
import type { TableSessionsService } from '../reception/table-sessions.service';

/**
 * The staff pushes the clock raises rather than a command (C10, spec §2.7),
 * queued by the push sweep (`PushSweepService`) every five minutes:
 *
 * - **PS12, a table still occupied**: each seating the Free Table Reminder
 *   asks about (`seatingsDueReminder`, the bell's own read), once per
 *   seating (`free:<table>:<since>`).
 * - **PS11, today's arrivals, and PS13, bills left open from a previous
 *   day**: one digest each a Lagos day, only between 09:00 and 10:00
 *   (`DIGEST_WINDOW`), counted with the bell's own filters, none at zero.
 *   The bell rings these one by one; a push per booking or per bill at
 *   Lagos midnight would wake people.
 *
 * Runs overlap and the dedupe keys make a repeat do nothing. A run missed
 * for the whole hour sends no digest that day: the bell still shows the
 * items, and nothing depends on a sweep having run.
 *
 * Each push is queued in a transaction of its own (the queue's savepoint
 * needs one). Each answers how many topics it wrote, a repeat included.
 */

/** The daily digests' hour in Jos: 09:00 inclusive to 10:00 exclusive. */
export const DIGEST_WINDOW = {
  opensAtMinutes: 9 * 60,
  closesAtMinutes: 10 * 60,
};

/** Whether `now` falls in the digests' hour, Lagos time. */
export function inDigestWindow(now: Date): boolean {
  const minutes = watMinutesOfDay(now);

  return (
    minutes >= DIGEST_WINDOW.opensAtMinutes &&
    minutes < DIGEST_WINDOW.closesAtMinutes
  );
}

/** PS12: every seating past its Free Table Reminder, to Reception's chain. */
export async function queueStaleTables(
  prisma: CncPrismaService,
  tables: TableSessionsService,
  queue: PushQueueService,
  now: Date,
): Promise<number> {
  let queued = 0;

  for (const seating of await tables.seatingsDueReminder(now)) {
    const topic = await prisma.$transaction((tx) =>
      queue.enqueueStaff(
        tx,
        'table.still_occupied',
        () => ({
          tableId: asId(seating.tableId),
          table: asTableName(seating.tableName),
          since: seating.since,
          seatedMinutes: Math.floor(
            (now.getTime() - seating.since.getTime()) / 60_000,
          ),
        }),
        { roles: [StaffRole.RECEPTION] },
      ),
    );

    if (topic !== null) queued += 1;
  }

  return queued;
}

/**
 * PS11 and PS13, inside the digests' hour only: today's bookings to every
 * active Reception account (else the managers), and the bills left open
 * from earlier days to the managers and every active Cashier.
 */
export async function queueDailyDigests(
  prisma: CncPrismaService,
  queue: PushQueueService,
  now: Date,
): Promise<number> {
  if (!inDigestWindow(now)) return 0;

  const day = watDay(now);
  let queued = 0;

  const arrivals = await prisma.reservation.findMany({
    where: expectedArrivalsWhere(now),
    select: { startMinutes: true },
  });

  if (arrivals.length > 0) {
    const first = Math.min(...arrivals.map((row) => row.startMinutes));
    const topic = await prisma.$transaction((tx) =>
      queue.enqueueStaff(
        tx,
        'arrivals.digest',
        () => ({
          day,
          count: arrivals.length,
          firstTime: watTimeLabel(first),
        }),
        { everyone: [StaffRole.RECEPTION] },
      ),
    );

    if (topic !== null) queued += 1;
  }

  const unsettled = await prisma.order.count({
    where: unsettledBillsWhere(now),
  });

  if (unsettled > 0) {
    const topic = await prisma.$transaction((tx) =>
      queue.enqueueStaff(
        tx,
        'orders.unsettled',
        { day, count: unsettled },
        { everyone: [StaffRole.CASHIER], managers: true },
      ),
    );

    if (topic !== null) queued += 1;
  }

  return queued;
}
