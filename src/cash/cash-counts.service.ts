import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentMethod, type Prisma } from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { formatIsoDate, parseIsoDate } from '../common/calendar-date';
import { resolveDateRange } from '../common/date-range';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { watToday } from '../common/wat';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { INT4_MAX } from '../prisma/int4';
import { drawNumber } from '../prisma/sequences';
import { CASH_FUTURE_MESSAGE } from './cash-messages';
import type {
  CashCountResponse,
  CashReportQuery,
  CashReportResponse,
  CreateCashCountRequest,
} from './dto/cash-count.dto';

type Tx = Prisma.TransactionClient;

/** The longest range one cash report covers: a year. */
const CASH_REPORT_MAX_DAYS = 366;

const COUNT_COLUMNS = {
  id: true,
  number: true,
  businessDate: true,
  staffId: true,
  expectedKobo: true,
  countedKobo: true,
  differenceKobo: true,
  createdAt: true,
  staff: { select: { name: true } },
} satisfies Prisma.CashCountSelect;

type CountRow = Prisma.CashCountGetPayload<{ select: typeof COUNT_COLUMNS }>;

/**
 * The Cash Reconciliation (plan §4.3, §6.2, §10; card C4-8): the Cashier's
 * drawer count (`cash.count`, R(Cashier)) and the report that lists the
 * counts.
 *
 * A count compares what was counted with the cash the system recorded for
 * the date: the non-reversed `CASH` payments dated that day, refunds
 * included, as the demo sums them. Payments are dated with the day the
 * money was taken (C4-5), so a carried bill settled after midnight counts
 * on the day its cash went in the drawer. Several counts per date are
 * allowed, as in the demo; each keeps the figures it was recorded with.
 */
@Injectable()
export class CashCountsService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `cash.count`, inside the idempotency service's transaction: a retry
   * after a lost response replays the first count instead of recording a
   * second (*Idempotency*: a create whose retry would make a second
   * record).
   */
  async count(
    tx: Tx,
    actor: StaffPrincipal,
    request: CreateCashCountRequest,
    ipAddress: string,
  ): Promise<CashCountResponse> {
    const today = formatIsoDate(watToday(new Date()));

    // `YYYY-MM-DD` strings compare as the days they name.
    if (request.businessDate > today) {
      throw new BadRequestException(CASH_FUTURE_MESSAGE);
    }

    const expectedKobo = await this.cashTakenKobo(
      tx,
      request.businessDate,
      request.businessDate,
    );
    const differenceKobo = request.countedKobo - expectedKobo;

    // The columns are `Int` (C4-1). A day's cash above ₦21 million would
    // reach Postgres as an out-of-range error; say so plainly instead.
    if (
      Math.abs(expectedKobo) > INT4_MAX ||
      Math.abs(differenceKobo) > INT4_MAX
    ) {
      throw new Error(
        'A cash count is beyond the range CashCount can store (Int kobo).',
      );
    }

    const number = await drawNumber(tx, 'cashCount');
    const row = await tx.cashCount.create({
      data: {
        number,
        businessDate: parseIsoDate(request.businessDate)!,
        staffId: actor.id,
        expectedKobo,
        countedKobo: request.countedKobo,
        differenceKobo,
      },
      select: COUNT_COLUMNS,
    });

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'cash.count',
        ref: number,
        after: {
          businessDate: request.businessDate,
          expectedKobo,
          countedKobo: request.countedKobo,
          differenceKobo,
        },
        ipAddress,
      },
      tx,
    );

    return toResponse(row);
  }

  /**
   * `GET /staff/reports/cash?from&to`: the counts recorded for dates in the
   * range, in the order they were recorded (the demo's list), with the cash
   * taken in the range and the latest count's difference (the report's
   * Cash Received in Range and Latest Variance).
   */
  async report(query: CashReportQuery): Promise<CashReportResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const range = resolveDateRange(query, new Date(), {
      defaultDays: 1,
      maxDays: CASH_REPORT_MAX_DAYS,
      subject: 'The cash reconciliation',
    });
    const where: Prisma.CashCountWhereInput = {
      businessDate: { gte: range.from, lte: range.to },
    };

    const rows = await this.prisma.cashCount.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: COUNT_COLUMNS,
    });
    const total = await this.prisma.cashCount.count({ where });
    const latest = await this.prisma.cashCount.findFirst({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { differenceKobo: true },
    });
    const from = formatIsoDate(range.from);
    const to = formatIsoDate(range.to);

    return {
      data: rows.map(toResponse),
      page,
      pageSize,
      total,
      from,
      to,
      cashReceivedKobo: await this.cashTakenKobo(this.prisma, from, to),
      latestDifferenceKobo: latest?.differenceKobo ?? 0,
    };
  }

  /**
   * The non-reversed cash payments dated from `from` to `to`, summed as
   * `bigint` (plan §10: an `Int` sum overflows over a long range).
   */
  private async cashTakenKobo(
    client: Pick<Tx, '$queryRaw'>,
    from: string,
    to: string,
  ): Promise<number> {
    const [{ total }] = await client.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("amountKobo"), 0)::bigint AS "total"
        FROM "Payment"
       WHERE "method" = ${PaymentMethod.CASH}::"PaymentMethod"
         AND NOT "reversed"
         AND "businessDate" BETWEEN ${from}::date AND ${to}::date`;

    return Number(total);
  }
}

function toResponse(row: CountRow): CashCountResponse {
  return {
    id: row.id,
    number: row.number,
    businessDate: formatIsoDate(row.businessDate),
    staffId: row.staffId,
    staffName: row.staff.name,
    expectedKobo: row.expectedKobo,
    countedKobo: row.countedKobo,
    differenceKobo: row.differenceKobo,
    createdAt: row.createdAt.toISOString(),
  };
}
