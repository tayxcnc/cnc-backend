import { Injectable } from '@nestjs/common';
import { formatIsoDate } from '../common/calendar-date';
import { resolveDateRange } from '../common/date-range';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { parseDocketItems } from '../orders/docket-items';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { readKitchenMappings } from '../stock/kitchen-mapping.service';
import type { KitchenCrosscheckQuery } from './dto/kitchen.request';
import type {
  CrosscheckLineResponse,
  CrosscheckPageResponse,
} from './dto/kitchen.response';
import {
  crosscheck,
  CrosscheckStatus,
  type CrosscheckDocket,
  type CrosscheckEntry,
} from './kitchen-crosscheck';
import { parseKitchenLines, type KitchenLine } from './kitchen-rules';

/** The longest range one crosscheck read covers: a year. */
const CROSSCHECK_MAX_DAYS = 366;

const ENTRY_COLUMNS = {
  docketRef: true,
  orderId: true,
  revision: true,
  businessDate: true,
  lines: true,
  createdAt: true,
  order: { select: { number: true } },
} as const;

/**
 * The Kitchen Crosscheck report (plan §7.10, §10; card C4-6), computed on
 * read (A20): every docket whose business date is in the range, at its
 * latest revision, compared with the kitchen's entry and the dishes'
 * comparison rules by `crosscheck()`, then the range's kitchen entries no
 * docket explains.
 *
 * Rows come in the order the latest revisions were written (the demo's
 * list order), then the unexplained entries in the order they were
 * recorded. The comparison rules are read as they stand now, as the demo
 * reads them. C8's report screen and the overview's Needs Attention count
 * (`notMatched`) read this.
 */
@Injectable()
export class KitchenCrosscheckService {
  constructor(private readonly prisma: CncPrismaService) {}

  async report(query: KitchenCrosscheckQuery): Promise<CrosscheckPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const range = resolveDateRange(query, new Date(), {
      defaultDays: 1,
      maxDays: CROSSCHECK_MAX_DAYS,
      subject: 'The kitchen crosscheck',
    });
    // Bound as `YYYY-MM-DD` text, never a Date (see `DocketsService.list`).
    const from = formatIsoDate(range.from);
    const to = formatIsoDate(range.to);

    // Every revision of a ref carries its bill's business date, so the
    // latest revision of each ref in the range is the latest of the ref.
    const latest = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT ON (d."ref") d."id"
        FROM "Docket" d
       WHERE d."businessDate" BETWEEN ${from}::date AND ${to}::date
       ORDER BY d."ref", d."revision" DESC`;
    const docketRows = await this.prisma.docket.findMany({
      where: { id: { in: latest.map((row) => row.id) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        ref: true,
        orderId: true,
        revision: true,
        businessDate: true,
        items: true,
        order: { select: { number: true } },
      },
    });

    const dockets: CrosscheckDocket[] = docketRows.map((row) => ({
      ref: row.ref,
      orderId: row.orderId,
      orderNumber: row.order.number,
      businessDate: formatIsoDate(row.businessDate),
      revision: row.revision,
      items: parseDocketItems(row.items).map((item) => ({
        menuItemId: item.menuItemId,
        qty: item.qty,
      })),
    }));

    const matched = await this.prisma.kitchenEntry.findMany({
      where: { docketRef: { in: dockets.map((docket) => docket.ref) } },
      select: ENTRY_COLUMNS,
    });
    // An entry dated in the range whose ref no docket of any date carries.
    const orphanIds = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id"
        FROM "KitchenEntry" e
       WHERE e."businessDate" BETWEEN ${from}::date AND ${to}::date
         AND NOT EXISTS (
               SELECT 1 FROM "Docket" d WHERE upper(d."ref") = upper(e."docketRef"))`;
    const orphans = await this.prisma.kitchenEntry.findMany({
      where: { id: { in: orphanIds.map((row) => row.id) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: ENTRY_COLUMNS,
    });

    const entries: CrosscheckEntry[] = [...matched, ...orphans].map((row) => ({
      docketRef: row.docketRef,
      orderId: row.orderId,
      orderNumber: row.order.number,
      businessDate: formatIsoDate(row.businessDate),
      revision: row.revision,
      lines: parseKitchenLines(row.lines),
    }));

    const menuItemIds = [
      ...new Set(
        dockets.flatMap((docket) => docket.items.map((i) => i.menuItemId)),
      ),
    ];
    const rules = await readKitchenMappings(this.prisma, menuItemIds);
    const rows = crosscheck(dockets, entries, rules);

    const names = await this.stockNames(
      rows.flatMap((row) => [...row.expected, ...row.actual]),
    );
    const named = (lines: KitchenLine[]): CrosscheckLineResponse[] =>
      lines.map((line) => ({
        stockItemId: line.stockItemId,
        stockItemName: names.get(line.stockItemId) ?? '',
        qty: line.qty,
      }));

    return {
      data: rows.slice((page - 1) * pageSize, page * pageSize).map((row) => ({
        ...row,
        expected: named(row.expected),
        actual: named(row.actual),
      })),
      page,
      pageSize,
      total: rows.length,
      from,
      to,
      notMatched: rows.filter((row) => row.status !== CrosscheckStatus.MATCHED)
        .length,
    };
  }

  private async stockNames(
    lines: readonly KitchenLine[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(lines.map((line) => line.stockItemId))];

    if (ids.length === 0) return new Map();

    const items = await this.prisma.stockItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });

    return new Map(items.map((item) => [item.id, item.name]));
  }
}
