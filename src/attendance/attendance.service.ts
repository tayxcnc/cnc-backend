import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceSource, Prisma } from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import { STAFF_NOT_FOUND_MESSAGE } from '../auth/staff-auth.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { formatIsoDate } from '../common/calendar-date';
import { DEFAULT_PAGE, MAX_PAGE_SIZE } from '../common/dto/pagination.query';
import { watToday } from '../common/wat';
import { formatWatShortStamp } from '../common/wat-format';
import { PhotoStore } from '../images/photo-store.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import { uniqueViolationTargets } from '../prisma/unique-violation';
import {
  ATTENDANCE_EXPORT_COLUMNS,
  ATTENDANCE_EXPORT_TITLE,
  ATTENDANCE_FUTURE_MESSAGE,
  ATTENDANCE_NOT_FOUND_MESSAGE,
  ATTENDANCE_OVERLAP_MESSAGE,
  ATTENDANCE_TIMES_MESSAGE,
  CHECKOUT_AFTER_ARRIVAL_MESSAGE,
  CHECKOUT_AFTER_CHECKIN_MESSAGE,
  SCAN_INVALID_MESSAGE,
} from './attendance-messages';
import {
  attendanceSummary,
  overlaps,
  parseStaffCode,
  parseWatWallClock,
  type Period,
  periodFor,
  roundHours,
  type ShiftFilter,
  scanStep,
  shiftHours,
  tokensMatch,
  validatePeriod,
} from './attendance-rules';
import type {
  AttendanceExportQuery,
  AttendancePeopleQuery,
  AttendanceQuery,
  CorrectAttendanceRequest,
} from './dto/attendance.request';
import type {
  AttendanceDirectoryResponse,
  AttendanceExportResponse,
  AttendancePageResponse,
  AttendancePersonResponse,
  AttendanceRecordResponse,
  ScanAttendanceResponse,
} from './dto/attendance.response';

type Tx = Prisma.TransactionClient;

/** What the answers are read through: the pool, or a command's transaction. */
type Reader = Pick<Prisma.TransactionClient, 'attendanceCorrection' | 'staff'>;

/** The columns a shift is answered from, without its relations. */
const RECORD_COLUMNS = {
  id: true,
  staffId: true,
  businessDate: true,
  timeIn: true,
  timeOut: true,
  source: true,
  version: true,
} satisfies Prisma.AttendanceRecordSelect;

type RecordRow = Prisma.AttendanceRecordGetPayload<{
  select: typeof RECORD_COLUMNS;
}>;

/** The person a read is about. */
const PERSON_COLUMNS = {
  id: true,
  staffNo: true,
  name: true,
  role: true,
  isActive: true,
  photo: true,
} satisfies Prisma.StaffSelect;

type PersonRow = Prisma.StaffGetPayload<{ select: typeof PERSON_COLUMNS }>;

/** What an audit row says about a shift: its dates and times, no ids. */
function auditFields(
  row: Pick<RecordRow, 'businessDate' | 'timeIn' | 'timeOut'>,
) {
  return {
    businessDate: formatIsoDate(row.businessDate),
    timeIn: row.timeIn.toISOString(),
    timeOut: row.timeOut?.toISOString() ?? null,
  };
}

/**
 * Throw a period rule's sentence as a 400; the rules throw plain errors so
 * they stay free of Nest.
 */
function period(read: () => Period): Period {
  try {
    return read();
  } catch (error) {
    throw new BadRequestException((error as Error).message);
  }
}

/** The shifts a filter keeps. */
function filterWhere(
  filter: ShiftFilter | undefined,
): Prisma.AttendanceRecordWhereInput {
  if (filter === 'COMPLETED') return { timeOut: { not: null } };
  if (filter === 'OPEN') return { timeOut: null };

  return {};
}

/**
 * Staff attendance (plan §4.7, §5.3, §5.4, §7.9; card C5-7; Q12's default:
 * timestamps only, and the export is the "Attendance review").
 *
 * - **The scan** (`attendance.scan`, Reception): the camera or a USB
 *   scanner sends the decoded staff ID. The token in it is compared with
 *   the account's in constant time and then dropped: it is never returned,
 *   logged or written to an audit row. An open shift closes from an hour
 *   after its arrival (overnight included) and a scan before that is an
 *   ignored repeat; with none open, a scan within a minute of the
 *   departure is an ignored repeat and any other starts a new shift. Each scan takes an advisory lock on the
 *   person, TAY's arrangement, so two scans of one card are serialised;
 *   the partial unique index `AttendanceRecord_staffId_key` (one open shift
 *   per person) is the backstop.
 * - **The correction** (`attendance.correct`, managers with a reason)
 *   keeps the times it replaced as an `AttendanceCorrection`, returned with
 *   the record, and refuses a shift that would overlap another.
 * - **The reads**: a manager's directory and per-person month, the export,
 *   and everyone's own My Attendance.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
    private readonly photos: PhotoStore,
  ) {}

  /**
   * `attendance.scan`. A code that is not a staff ID, names nobody,
   * carries the wrong token, or belongs to a deactivated account is the
   * demo's one 400 sentence, so the scanner never tells which.
   */
  async scan(
    actor: StaffPrincipal,
    code: string,
    ipAddress: string,
  ): Promise<ScanAttendanceResponse> {
    const scanned = parseStaffCode(code);
    const person =
      scanned === null
        ? null
        : await this.prisma.staff.findUnique({
            where: { staffNo: scanned.staffNo },
            select: { ...PERSON_COLUMNS, qrToken: true },
          });

    if (
      scanned === null ||
      person === null ||
      !tokensMatch(person.qrToken, scanned.token) ||
      !person.isActive
    ) {
      throw new BadRequestException(SCAN_INVALID_MESSAGE);
    }

    const now = new Date();
    let outcome: {
      action: ScanAttendanceResponse['action'];
      at: Date;
      present: boolean;
    };

    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        await this.lockPerson(tx, person.id);

        const latest = await tx.attendanceRecord.findFirst({
          where: { staffId: person.id },
          orderBy: [{ timeIn: 'desc' }, { id: 'desc' }],
          select: RECORD_COLUMNS,
        });
        const open = await tx.attendanceRecord.findFirst({
          where: { staffId: person.id, timeOut: null },
          select: RECORD_COLUMNS,
        });
        const step = scanStep(latest, open, now);

        if (step === 'REPEAT' && latest !== null) {
          // The demo returns before recording anything, audit included.
          return {
            action: 'REPEAT_IGNORED' as const,
            at: open?.timeIn ?? latest.timeOut ?? latest.timeIn,
            present: open !== null,
          };
        }

        if (step === 'CHECK_OUT' && open !== null) {
          if (now < open.timeIn) {
            throw new ConflictException(CHECKOUT_AFTER_ARRIVAL_MESSAGE);
          }

          // The version moves, so a correction opened on the shift before
          // the departure is refused as stale rather than undoing it.
          const closed = await tx.attendanceRecord.update({
            where: { id: open.id },
            data: { timeOut: now, version: { increment: 1 } },
            select: RECORD_COLUMNS,
          });

          await this.audit.record(
            {
              actor: staffActor(actor),
              action: 'attendance.scan',
              ref: person.staffNo,
              before: auditFields(open),
              after: auditFields(closed),
              ipAddress,
            },
            tx,
          );

          return { action: 'CHECKED_OUT' as const, at: now, present: false };
        }

        const opened = await tx.attendanceRecord.create({
          data: {
            staffId: person.id,
            businessDate: watToday(now),
            timeIn: now,
            source: AttendanceSource.RECEPTION_QR,
          },
          select: RECORD_COLUMNS,
        });

        await this.audit.record(
          {
            actor: staffActor(actor),
            action: 'attendance.scan',
            ref: person.staffNo,
            after: auditFields(opened),
            ipAddress,
          },
          tx,
        );

        return { action: 'CHECKED_IN' as const, at: now, present: true };
      });
    } catch (error) {
      // Under the lock a second open shift cannot be attempted; were the
      // index ever to refuse one, the person's shift moved under the scan.
      if (uniqueViolationTargets(error).includes('staffId')) {
        throw new ConflictException(ATTENDANCE_OVERLAP_MESSAGE);
      }

      throw error;
    }

    return {
      action: outcome.action,
      duplicate: outcome.action === 'REPEAT_IGNORED',
      present: outcome.present,
      staffId: person.id,
      staffNo: person.staffNo,
      name: person.name,
      role: person.role,
      photoUrl: await this.photos.signedUrlOrNull(person.photo),
      at: outcome.at.toISOString(),
    };
  }

  /**
   * `attendance.correct`, in the demo's order: the record, valid times,
   * nothing in the future, the time out after the time in, then no overlap
   * with another of the person's shifts (409). The times replaced are kept
   * as a correction with the reason; the business date follows the new
   * arrival. The person's lock is taken before the record is claimed, in
   * the scan's order, so a scan and a correction of one person cannot
   * deadlock.
   */
  async correct(
    actor: StaffPrincipal,
    id: string,
    request: CorrectAttendanceRequest,
    ipAddress: string,
  ): Promise<AttendanceRecordResponse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const owner = await tx.attendanceRecord.findUnique({
          where: { id },
          select: { staffId: true },
        });

        if (owner === null) {
          throw new NotFoundException(ATTENDANCE_NOT_FOUND_MESSAGE);
        }

        await this.lockPerson(tx, owner.staffId);
        await claimVersion(tx, {
          table: 'AttendanceRecord',
          id,
          version: request.version,
          notFound: ATTENDANCE_NOT_FOUND_MESSAGE,
        });

        const current = await tx.attendanceRecord.findUniqueOrThrow({
          where: { id },
          select: RECORD_COLUMNS,
        });
        const timeIn = parseWatWallClock(request.timeIn);
        const leftOpen =
          request.timeOut === undefined ||
          request.timeOut === null ||
          request.timeOut === '';
        const timeOut = leftOpen ? null : parseWatWallClock(request.timeOut);

        if (timeIn === null || (!leftOpen && timeOut === null)) {
          throw new BadRequestException(ATTENDANCE_TIMES_MESSAGE);
        }

        const now = new Date();

        if (timeIn > now || (timeOut !== null && timeOut > now)) {
          throw new BadRequestException(ATTENDANCE_FUTURE_MESSAGE);
        }

        if (timeOut !== null && timeOut < timeIn) {
          throw new BadRequestException(CHECKOUT_AFTER_CHECKIN_MESSAGE);
        }

        const others = await tx.attendanceRecord.findMany({
          where: { staffId: current.staffId, id: { not: id } },
          select: { timeIn: true, timeOut: true },
        });

        if (others.some((other) => overlaps({ timeIn, timeOut }, other, now))) {
          throw new ConflictException(ATTENDANCE_OVERLAP_MESSAGE);
        }

        await tx.attendanceCorrection.create({
          data: {
            recordId: id,
            beforeIn: current.timeIn,
            beforeOut: current.timeOut,
            reason: request.reason,
            staffId: actor.id,
          },
        });

        const updated = await tx.attendanceRecord.update({
          where: { id },
          data: { timeIn, timeOut, businessDate: watToday(timeIn) },
          select: RECORD_COLUMNS,
        });
        const person = await tx.staff.findUniqueOrThrow({
          where: { id: current.staffId },
          select: { staffNo: true },
        });

        await this.audit.record(
          {
            actor: staffActor(actor),
            action: 'attendance.correct',
            ref: person.staffNo,
            before: auditFields(current),
            after: auditFields(updated),
            reason: request.reason,
            ipAddress,
          },
          tx,
        );

        const [answer] = await this.answerMany(tx, [updated]);

        return answer;
      });
    } catch (error) {
      // A shift reopened beside an open one meets the one-open-shift index.
      if (uniqueViolationTargets(error).includes('staffId')) {
        throw new ConflictException(ATTENDANCE_OVERLAP_MESSAGE);
      }

      throw error;
    }
  }

  /** `GET /staff/attendance/people`: the active staff, by name. */
  async people(
    query: AttendancePeopleQuery,
  ): Promise<AttendanceDirectoryResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? MAX_PAGE_SIZE;
    const filters: Prisma.StaffWhereInput[] = [{ isActive: true }];

    if (query.q) {
      const contains = {
        contains: query.q,
        mode: Prisma.QueryMode.insensitive,
      };

      filters.push({
        OR: [{ name: contains }, { staffNo: contains }, { email: contains }],
      });
    }

    const where: Prisma.StaffWhereInput = { AND: filters };
    const rows = await this.prisma.staff.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        staffNo: true,
        name: true,
        role: true,
        email: true,
        photo: true,
      },
    });
    const total = await this.prisma.staff.count({ where });
    const data: AttendanceDirectoryResponse['data'] = [];

    for (const row of rows) {
      data.push({
        id: row.id,
        staffNo: row.staffNo,
        name: row.name,
        role: row.role,
        email: row.email,
        photoUrl: await this.photos.signedUrlOrNull(row.photo),
      });
    }

    return { data, page, pageSize, total };
  }

  /**
   * `GET /staff/attendance/:staffId` (managers) and
   * `GET /staff/me/attendance` (everyone, their own): the person's shifts
   * in a period, oldest arrival first (the demo's `staffAttendance`), by
   * arrival date, with the summary over the shifts the filter keeps. A
   * page is a hundred shifts unless asked otherwise, so a month reads in
   * one page.
   */
  async records(
    staffId: string,
    query: AttendanceQuery,
  ): Promise<AttendancePageResponse> {
    const range = period(() => periodFor(query, new Date()));
    const read = await this.readPeriod(staffId, range, query.filter);
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? MAX_PAGE_SIZE;

    return {
      staff: read.person,
      from: formatIsoDate(range.from),
      to: formatIsoDate(range.to),
      summary: read.summary,
      data: read.shifts.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: read.shifts.length,
    };
  }

  /**
   * `GET /staff/attendance/:staffId/export`: the Attendance review (Q12's
   * default title) for a period, every shift, as the staff app's export
   * rows: Lagos times as its `timeLabel` prints them, hours to two places
   * and blank while open, Completed or Present, and the corrections.
   */
  async export(
    staffId: string,
    query: AttendanceExportQuery,
  ): Promise<AttendanceExportResponse> {
    const range = period(() => validatePeriod(query.from, query.to));
    const read = await this.readPeriod(staffId, range, 'ALL');
    const from = formatIsoDate(range.from);
    const to = formatIsoDate(range.to);
    const person = read.person;

    return {
      title: ATTENDANCE_EXPORT_TITLE,
      subtitle: `${person.name} | ${person.staffNo} | ${from} to ${to}`,
      fileName: `CNC-Attendance-review-${person.staffNo}-${from}-to-${to}`,
      staff: person,
      from,
      to,
      summary: read.summary,
      columns: [...ATTENDANCE_EXPORT_COLUMNS],
      rows: read.shifts.map((row) => [
        row.businessDate,
        person.staffNo,
        person.name,
        formatWatShortStamp(new Date(row.timeIn)),
        row.timeOut === null ? '' : formatWatShortStamp(new Date(row.timeOut)),
        row.hours === null ? '' : row.hours.toFixed(2),
        row.state === 'COMPLETED' ? 'Completed' : 'Present',
        String(row.corrections.length),
      ]),
    };
  }

  /**
   * A person's shifts that arrived in a period, oldest first, with the
   * summary over them (the demo's `staffAttendance` and
   * `attendanceSummary`). One person's period is at most a year of shifts,
   * so it is read whole and paged in memory.
   */
  private async readPeriod(
    staffId: string,
    range: Period,
    filter: ShiftFilter | undefined,
  ): Promise<{
    person: AttendancePersonResponse;
    shifts: AttendanceRecordResponse[];
    summary: AttendancePageResponse['summary'];
  }> {
    const person = await this.person(staffId);
    const rows = await this.prisma.attendanceRecord.findMany({
      where: {
        staffId,
        businessDate: { gte: range.from, lte: range.to },
        ...filterWhere(filter),
      },
      orderBy: [{ timeIn: 'asc' }, { id: 'asc' }],
      select: RECORD_COLUMNS,
    });
    const shifts = await this.answerMany(this.prisma, rows);

    return {
      person,
      shifts,
      summary: attendanceSummary(
        rows.map((row, index) => ({
          ...row,
          corrections: shifts[index].corrections.length,
        })),
      ),
    };
  }

  /**
   * The person's advisory lock, held to the end of the transaction: scans
   * and corrections of one person run one at a time.
   */
  private async lockPerson(tx: Tx, staffId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cnc:attendance:${staffId}`}))`;
  }

  private async person(staffId: string): Promise<AttendancePersonResponse> {
    const row: PersonRow | null = await this.prisma.staff.findUnique({
      where: { id: staffId },
      select: PERSON_COLUMNS,
    });

    if (row === null) throw new NotFoundException(STAFF_NOT_FOUND_MESSAGE);

    return {
      id: row.id,
      staffNo: row.staffNo,
      name: row.name,
      role: row.role,
      isActive: row.isActive,
      photoUrl: await this.photos.signedUrlOrNull(row.photo),
    };
  }

  /**
   * Shifts as the routes answer them, each with its corrections. The
   * corrections and the people who made them are separate queries awaited
   * in turn, so this is safe inside a transaction (*Data and migrations*).
   */
  private async answerMany(
    client: Reader,
    rows: readonly RecordRow[],
  ): Promise<AttendanceRecordResponse[]> {
    if (rows.length === 0) return [];

    const corrections = await client.attendanceCorrection.findMany({
      where: { recordId: { in: rows.map((row) => row.id) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        recordId: true,
        createdAt: true,
        staffId: true,
        reason: true,
        beforeIn: true,
        beforeOut: true,
      },
    });
    const people = await client.staff.findMany({
      where: { id: { in: [...new Set(corrections.map((c) => c.staffId))] } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(people.map((person) => [person.id, person.name]));

    return rows.map((row) => ({
      id: row.id,
      staffId: row.staffId,
      businessDate: formatIsoDate(row.businessDate),
      timeIn: row.timeIn.toISOString(),
      timeOut: row.timeOut?.toISOString() ?? null,
      source: row.source,
      state: row.timeOut === null ? 'PRESENT' : 'COMPLETED',
      hours: row.timeOut === null ? null : roundHours(shiftHours(row)),
      corrections: corrections
        .filter((correction) => correction.recordId === row.id)
        .map((correction) => ({
          at: correction.createdAt.toISOString(),
          staffId: correction.staffId,
          staffName: nameOf.get(correction.staffId) ?? '',
          reason: correction.reason,
          beforeIn: correction.beforeIn.toISOString(),
          beforeOut: correction.beforeOut?.toISOString() ?? null,
        })),
      version: row.version,
    }));
  }
}
