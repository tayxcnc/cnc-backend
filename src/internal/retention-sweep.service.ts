import { Injectable } from '@nestjs/common';
import { watDayBounds, watToday } from '../common/wat';
import { CncPrismaService } from '../prisma/cnc-prisma.service';

/**
 * Q36's default, which the founder left standing: enquiries are kept twelve
 * months and attendance two years (Nigeria Data Protection Act 2023, BE §10).
 */
export const ENQUIRY_RETENTION_MONTHS = 12;
export const ATTENDANCE_RETENTION_YEARS = 2;

/** Rows deleted per statement. */
export const RETENTION_BATCH = 500;

/**
 * Statements per table per run, so one run deletes at most
 * `RETENTION_BATCH × RETENTION_MAX_BATCHES` rows of each table and its
 * request stays short; whatever is left goes in the next day's run.
 */
export const RETENTION_MAX_BATCHES = 20;

/** What one run of the retention sweep deleted. */
export interface RetentionSweepResult {
  enquiries: number;
  attendanceRecords: number;
  /** True when a table still held rows past its period at the run's cap. */
  more: boolean;
}

/**
 * The same calendar date `years` and `months` earlier, at UTC midnight. A
 * date the earlier month lacks (29 February, 31 April) rolls on to the next
 * day, so a row is kept a day longer, never deleted a day early.
 */
function calendarDateBefore(date: Date, years: number, months: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear() - years,
      date.getUTCMonth() - months,
      date.getUTCDate(),
    ),
  );
}

/**
 * The first Lagos day an enquiry is still kept: the same date twelve months
 * before today in Jos. An enquiry made before that day's start is deleted.
 */
export function enquiryCutoff(now: Date): Date {
  return watDayBounds(
    calendarDateBefore(watToday(now), 0, ENQUIRY_RETENTION_MONTHS),
  ).start;
}

/**
 * The first business date a shift is still kept: the same date two years
 * before today in Jos. A shift dated before it is deleted.
 */
export function attendanceCutoff(now: Date): Date {
  return calendarDateBefore(watToday(now), ATTENDANCE_RETENTION_YEARS, 0);
}

/**
 * The retention sweep (`POST /internal/sweeps/retention`, card C8-5, Q36):
 * enquiries made more than twelve months ago, and finished shifts dated
 * more than two years ago, deleted in batches.
 *
 * **What else holds these rows was checked first.** Nothing references an
 * `Enquiry`; its email to CNC's inbox (`OutboundMessage`, key
 * `enquiry:<id>`) keeps only CNC's own address once sent, and its payload is
 * cleared then. An `AttendanceRecord` is referenced only by its
 * `AttendanceCorrection` rows, which cascade with it: a correction is the
 * shift's own history and means nothing without the shift. The audit log
 * names a scan or a correction by the person's staff number, never by the
 * record, so every audit read stays whole; and the audit log itself is
 * append-only by trigger and never swept (A13). The attendance reads and
 * the export read at most 366 days, so no screen asks for a deleted shift.
 *
 * **An open shift is never deleted, however old.** It is the state the next
 * scan of that person acts on (it closes it), and the partial unique index
 * allows one per person; deleting it would change what a scan does.
 *
 * **Idempotent:** a second run the same day finds nothing past its period.
 * Each batch selects its ids and deletes them with the cutoff repeated, so a
 * row written meanwhile can never be caught. Batches commit one by one: one
 * table deleted is better than none, as the tokens sweep says.
 *
 * Housekeeping, never correctness: nothing reads these rows for a rule, so
 * a missed run changes nothing anyone sees for a day.
 */
@Injectable()
export class RetentionSweepService {
  constructor(private readonly prisma: CncPrismaService) {}

  async sweep(now: Date): Promise<RetentionSweepResult> {
    const enquiries = await this.inBatches(async () => {
      const cutoff = enquiryCutoff(now);
      const rows = await this.prisma.enquiry.findMany({
        where: { createdAt: { lt: cutoff } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: RETENTION_BATCH,
        select: { id: true },
      });

      if (rows.length === 0) return { selected: 0, deleted: 0 };

      const { count } = await this.prisma.enquiry.deleteMany({
        where: {
          id: { in: rows.map(({ id }) => id) },
          createdAt: { lt: cutoff },
        },
      });

      return { selected: rows.length, deleted: count };
    });

    const attendance = await this.inBatches(async () => {
      const cutoff = attendanceCutoff(now);
      const rows = await this.prisma.attendanceRecord.findMany({
        where: { businessDate: { lt: cutoff }, timeOut: { not: null } },
        orderBy: [{ businessDate: 'asc' }, { id: 'asc' }],
        take: RETENTION_BATCH,
        select: { id: true },
      });

      if (rows.length === 0) return { selected: 0, deleted: 0 };

      const { count } = await this.prisma.attendanceRecord.deleteMany({
        where: {
          id: { in: rows.map(({ id }) => id) },
          businessDate: { lt: cutoff },
          timeOut: { not: null },
        },
      });

      return { selected: rows.length, deleted: count };
    });

    return {
      enquiries: enquiries.deleted,
      attendanceRecords: attendance.deleted,
      more: enquiries.more || attendance.more,
    };
  }

  /**
   * Run `batch` until it selects fewer rows than a full batch, or the run's
   * cap is reached (`more` is then true).
   */
  private async inBatches(
    batch: () => Promise<{ selected: number; deleted: number }>,
  ): Promise<{ deleted: number; more: boolean }> {
    let deleted = 0;

    for (let round = 0; round < RETENTION_MAX_BATCHES; round += 1) {
      const result = await batch();

      deleted += result.deleted;

      if (result.selected < RETENTION_BATCH) return { deleted, more: false };
    }

    return { deleted, more: true };
  }
}
