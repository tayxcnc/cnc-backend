import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/cnc-client';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { addDays, formatIsoDate } from '../common/calendar-date';
import { REPORT_MAX_DAYS, reportPeriod } from '../common/report-period';
import { watToday } from '../common/wat';
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
  type CrosscheckRow,
} from './kitchen-crosscheck';
import { parseKitchenLines, type KitchenLine } from './kitchen-rules';

/** Business dates as `YYYY-MM-DD`, inclusive; `to` null: no end. */
type CrosscheckRange = { from: string; to: string | null };

/** A kitchen entry as the crosscheck's raw reads return it. */
interface EntryRow {
  docketRef: string;
  orderId: string;
  orderNumber: string;
  revision: number;
  businessDate: string;
  lines: Prisma.JsonValue;
}

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
 * reads them. The report screen reads `report`; the overview's Needs
 * Attention count reads `notMatchedCount`, over the last year's dates
 * (card C8-1; the demo ran `crosscheck(s)` over its whole store, which a
 * browser's store kept small). Both go through one loader, so the count
 * is always the report's own `notMatched` for that range.
 */
@Injectable()
export class KitchenCrosscheckService {
  constructor(private readonly prisma: CncPrismaService) {}

  async report(query: KitchenCrosscheckQuery): Promise<CrosscheckPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const range = reportPeriod(query, 'The kitchen crosscheck');
    const from = range.fromIso;
    const to = range.toIso;
    const rows = await this.rows({ from, to });

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
      notMatched: notMatched(rows),
    };
  }

  /**
   * The overview's Needs Attention "Kitchen Crosscheck" count: the rows
   * whose result is not Matched, dated from {@link REPORT_MAX_DAYS} days
   * back (today included) on, a web order's later slot too. An exception
   * stays counted until it is put right or a year old: a manager may still
   * record a kitchen entry for an earlier date. *Decision* (C8 review): the
   * demo counted its whole store; over every date the count read every
   * docket ever written on every manager's poll (about 520 ms a year of
   * history, and growing), where a year is the longest range the report
   * itself reads.
   */
  async notMatchedCount(now: Date = new Date()): Promise<number> {
    const from = formatIsoDate(addDays(watToday(now), 1 - REPORT_MAX_DAYS));

    return notMatched(await this.rows({ from, to: null }));
  }

  /**
   * The crosscheck's rows for a range of business dates. Five reads,
   * whatever the number of dockets: the latest revisions, the entries
   * under their refs, the entries no docket explains, the rules, and
   * nothing per row.
   */
  private async rows(range: CrosscheckRange): Promise<CrosscheckRow[]> {
    // Bound as `YYYY-MM-DD` text, never a Date (see `DocketsService.list`).
    const docketIn = (alias: string) =>
      range.to === null
        ? Prisma.sql`${Prisma.raw(alias)}."businessDate" >= ${range.from}::date`
        : Prisma.sql`${Prisma.raw(alias)}."businessDate" BETWEEN ${range.from}::date AND ${range.to}::date`;

    // Every revision of a ref carries its bill's business date, so the
    // latest revision of each ref in the range is the latest of the ref.
    const docketRows = await this.prisma.$queryRaw<
      {
        ref: string;
        orderId: string;
        orderNumber: string;
        revision: number;
        businessDate: string;
        items: Prisma.JsonValue;
      }[]
    >`
      SELECT x."ref", x."orderId", x."orderNumber", x."revision",
             x."businessDate", x."items"
        FROM (SELECT DISTINCT ON (d."ref")
                     d."id", d."ref", d."orderId", o."number" AS "orderNumber",
                     d."revision", d."businessDate"::text AS "businessDate",
                     d."items", d."createdAt"
                FROM "Docket" d
                JOIN "Order" o ON o."id" = d."orderId"
               WHERE ${docketIn('d')}
               ORDER BY d."ref", d."revision" DESC) x
       ORDER BY x."createdAt", x."id"`;

    const dockets: CrosscheckDocket[] = docketRows.map((row) => ({
      ref: row.ref,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      businessDate: row.businessDate,
      revision: row.revision,
      items: parseDocketItems(row.items).map((item) => ({
        menuItemId: item.menuItemId,
        qty: item.qty,
      })),
    }));

    // The entries filed under a ref one of those dockets carries.
    const matched = await this.prisma.$queryRaw<EntryRow[]>`
      SELECT e."docketRef", e."orderId", o."number" AS "orderNumber",
             e."revision", e."businessDate"::text AS "businessDate", e."lines"
        FROM "KitchenEntry" e
        JOIN "Order" o ON o."id" = e."orderId"
       WHERE EXISTS (SELECT 1 FROM "Docket" d
                      WHERE d."ref" = e."docketRef" AND ${docketIn('d')})`;
    // An entry dated in the range whose ref no docket of any date carries.
    const orphans = await this.prisma.$queryRaw<EntryRow[]>`
      SELECT e."docketRef", e."orderId", o."number" AS "orderNumber",
             e."revision", e."businessDate"::text AS "businessDate", e."lines"
        FROM "KitchenEntry" e
        JOIN "Order" o ON o."id" = e."orderId"
       WHERE ${docketIn('e')}
         AND NOT EXISTS (
               SELECT 1 FROM "Docket" d WHERE upper(d."ref") = upper(e."docketRef"))
       ORDER BY e."createdAt", e."id"`;

    const entries: CrosscheckEntry[] = [...matched, ...orphans].map((row) => ({
      docketRef: row.docketRef,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      businessDate: row.businessDate,
      revision: row.revision,
      lines: parseKitchenLines(row.lines),
    }));

    const menuItemIds = [
      ...new Set(
        dockets.flatMap((docket) => docket.items.map((i) => i.menuItemId)),
      ),
    ];
    const rules = await readKitchenMappings(this.prisma, menuItemIds);

    return crosscheck(dockets, entries, rules);
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

/** How many rows are anything but Matched. */
function notMatched(rows: readonly CrosscheckRow[]): number {
  return rows.filter((row) => row.status !== CrosscheckStatus.MATCHED).length;
}
