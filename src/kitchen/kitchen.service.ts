import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  StockKind,
  StockLocation,
  StockMovementType,
} from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { isManager, ROLE_REFUSED_MESSAGE } from '../auth/staff-roles';
import { ADMIN_REASON_MESSAGE } from '../common/admin-reason';
import { formatIsoDate, parseIsoDate } from '../common/calendar-date';
import { LINES_EMPTY_MESSAGE } from '../common/command-lines';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { watToday } from '../common/wat';
import { normaliseDocketRef } from '../orders/docket-items';
import { DocketsService } from '../orders/dockets.service';
import { DOCKET_NOT_FOUND_MESSAGE } from '../orders/order-messages';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import { uniqueViolationTargets } from '../prisma/unique-violation';
import { StockLedgerService } from '../stock/stock-ledger.service';
import type {
  KitchenEntriesQuery,
  SaveKitchenEntryRequest,
} from './dto/kitchen.request';
import type {
  KitchenDayResponse,
  KitchenEntryPageResponse,
  KitchenEntryResponse,
  KitchenLineResponse,
} from './dto/kitchen.response';
import {
  KITCHEN_CLOSE_TODAY_MESSAGE,
  KITCHEN_CLOSED_MESSAGE,
  KITCHEN_DATE_ASSIGNED_MESSAGE,
  KITCHEN_DUPLICATE_MESSAGE,
  KITCHEN_ENTRY_NOT_FOUND_MESSAGE,
  KITCHEN_FUTURE_MESSAGE,
  KITCHEN_ORDER_ASSIGNED_MESSAGE,
  KITCHEN_PORTION_MESSAGE,
  KITCHEN_REVISION_ASSIGNED_MESSAGE,
} from './kitchen-messages';
import {
  isKitchenCorrection,
  kitchenStockChanges,
  parseKitchenLines,
  type KitchenLine,
} from './kitchen-rules';

type Tx = Prisma.TransactionClient;

/**
 * The advisory-lock namespace for a kitchen day, hashed into the first key
 * of the two-key form (as `MoneyControlService`'s namespaces are). A save
 * holds it shared for each date it touches, and a close holds it
 * exclusively, so a day cannot close under a save that checked it open.
 */
const KITCHEN_DAY_LOCK = 'cnc:kitchen-day';

/** The columns an entry is answered from. */
const ENTRY_COLUMNS = {
  id: true,
  docketRef: true,
  orderId: true,
  revision: true,
  businessDate: true,
  lines: true,
  staffId: true,
  createdAt: true,
  updatedAt: true,
  version: true,
  order: { select: { number: true } },
  staff: { select: { name: true } },
} satisfies Prisma.KitchenEntrySelect;

type EntryRow = Prisma.KitchenEntryGetPayload<{
  select: typeof ENTRY_COLUMNS;
}>;

/** Either the base client or a command's transaction. */
type Reader = Pick<Tx, 'stockItem'>;

/**
 * The Kitchen screen (plan §5.4, §6.2; card C4-6): the kitchen's own record
 * of the portions it used, entered against the number on the paper docket
 * (`kitchen.save`), and the end of a kitchen day (`kitchen.close`).
 *
 * The order, revision and date of an entry come from the docket
 * (`DocketsService.latestByRef`), never from the screen. A save moves the
 * Kitchen balances by the difference it makes, through
 * `StockLedgerService`, in the same transaction as the entry and its audit
 * row: a first entry takes its portions, a correction returns what it
 * removed and takes what it added.
 */
@Injectable()
export class KitchenService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly dockets: DocketsService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `kitchen.save`: record or correct the portions for one docket.
   *
   * The demo's checks in its order, after the request's own shape (the
   * ValidationPipe runs first, *Money controls*):
   * 1. the docket exists (404);
   * 2. the kitchen date is not in the future, and a non-manager names no
   *    date, revision or order other than the docket's (400);
   * 3. with a `version`, the existing entry is claimed (A8);
   * 4. an entry for another day, a closed day, or an earlier day's entry,
   *    is a manager's correction with a reason (403, then 400);
   * 5. a first entry has at least one line (400), and there is no entry
   *    for the docket already (409);
   * 6. every line is a Kitchen portion (400);
   * 7. the entry is written, the Kitchen moves by the difference (409 when
   *    a portion would go below zero), and the audit row is written.
   */
  async save(
    actor: StaffPrincipal,
    refText: string,
    request: SaveKitchenEntryRequest,
    ipAddress: string,
  ): Promise<KitchenEntryResponse> {
    try {
      return await this.prisma.$transaction((tx) =>
        this.saveIn(tx, actor, normaliseDocketRef(refText), request, ipAddress),
      );
    } catch (error) {
      // Two first entries for one docket at once: the second waits on the
      // unique index and then clashes, after its own checks all passed.
      if (uniqueViolationTargets(error).includes('docketRef')) {
        throw new ConflictException(KITCHEN_DUPLICATE_MESSAGE);
      }

      throw error;
    }
  }

  private async saveIn(
    tx: Tx,
    actor: StaffPrincipal,
    ref: string,
    request: SaveKitchenEntryRequest,
    ipAddress: string,
  ): Promise<KitchenEntryResponse> {
    const docket = await this.dockets.latestByRef(tx, ref);

    if (docket === null) throw new NotFoundException(DOCKET_NOT_FOUND_MESSAGE);

    const manager = isManager(actor.role);
    const today = formatIsoDate(watToday(new Date()));
    const entryDate =
      manager && request.date !== undefined
        ? request.date
        : docket.businessDate;

    // `YYYY-MM-DD` strings compare as the days they name.
    if (entryDate > today) {
      throw new BadRequestException(KITCHEN_FUTURE_MESSAGE);
    }

    if (!manager) {
      if (request.date !== undefined && request.date !== docket.businessDate) {
        throw new BadRequestException(KITCHEN_DATE_ASSIGNED_MESSAGE);
      }

      if (
        request.revision !== undefined &&
        request.revision !== docket.revision
      ) {
        throw new BadRequestException(KITCHEN_REVISION_ASSIGNED_MESSAGE);
      }

      if (
        request.orderNumber !== undefined &&
        request.orderNumber !== docket.orderNumber
      ) {
        throw new BadRequestException(KITCHEN_ORDER_ASSIGNED_MESSAGE);
      }
    }

    const existing = await tx.kitchenEntry.findUnique({
      where: { docketRef: ref },
      select: { id: true },
    });

    let old: EntryRow | null = null;

    if (request.version !== undefined) {
      if (existing === null) {
        throw new NotFoundException(KITCHEN_ENTRY_NOT_FOUND_MESSAGE);
      }

      // The claim is the row lock the correction runs under: a second
      // device correcting the same entry names a version this one moved.
      await claimVersion(tx, {
        table: 'KitchenEntry',
        id: existing.id,
        version: request.version,
        notFound: KITCHEN_ENTRY_NOT_FOUND_MESSAGE,
      });

      old = await tx.kitchenEntry.findUniqueOrThrow({
        where: { id: existing.id },
        select: ENTRY_COLUMNS,
      });
    }

    const previousDate = old ? formatIsoDate(old.businessDate) : undefined;
    const closed = await this.lockDays(
      tx,
      previousDate === undefined ? [entryDate] : [entryDate, previousDate],
      'shared',
    );

    if (
      isKitchenCorrection({
        entryDate,
        docketDate: docket.businessDate,
        today,
        isClosed: (date) => closed.has(date),
        previousDate,
      })
    ) {
      // The demo's `admin()`: managers only, then the reason.
      if (!manager) throw new ForbiddenException(ROLE_REFUSED_MESSAGE);
      if (request.reason === undefined || request.reason === '') {
        throw new BadRequestException(ADMIN_REASON_MESSAGE);
      }
    }

    // An empty list only clears an existing entry (a cancelled docket).
    if (request.lines.length === 0 && old === null) {
      throw new BadRequestException(LINES_EMPTY_MESSAGE);
    }

    if (old === null && existing !== null) {
      throw new ConflictException(KITCHEN_DUPLICATE_MESSAGE);
    }

    const next: KitchenLine[] = request.lines.map((line) => ({
      stockItemId: line.stockItemId,
      qty: line.qty,
    }));
    await this.assertKitchenPortions(tx, next);

    const previous = old ? parseKitchenLines(old.lines) : [];
    const data = {
      orderId: docket.orderId,
      revision: docket.revision,
      businessDate: parseIsoDate(entryDate)!,
      lines: next.map((line) => ({ ...line })),
      staffId: actor.id,
    };

    // A first entry is inserted before any stock moves, so a second first
    // entry for the docket meets the unique index before it touches a
    // balance.
    const saved = old
      ? await tx.kitchenEntry.update({
          where: { id: old.id },
          data,
          select: ENTRY_COLUMNS,
        })
      : await tx.kitchenEntry.create({
          data: { ...data, docketRef: ref },
          select: ENTRY_COLUMNS,
        });

    for (const change of kitchenStockChanges(previous, next)) {
      await this.ledger.move(tx, {
        stockItemId: change.stockItemId,
        location: StockLocation.KITCHEN,
        qty: change.delta,
        type: old
          ? StockMovementType.KITCHEN_CORRECTION
          : StockMovementType.KITCHEN_ENTRY,
        ref,
        staffId: actor.id,
      });
    }

    const response = await this.toResponse(tx, saved);

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'kitchen.save',
        ref,
        before: old ? auditShape(await this.toResponse(tx, old)) : null,
        after: auditShape(response),
        reason: request.reason || null,
        ipAddress,
      },
      tx,
    );

    return response;
  }

  /**
   * `GET /staff/kitchen/entries?date&q`: one kitchen date's entries, in the
   * order they were first recorded (the demo's list), with the portions
   * recorded across every match.
   */
  async list(query: KitchenEntriesQuery): Promise<KitchenEntryPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const date =
      (query.date === undefined ? null : parseIsoDate(query.date)) ??
      watToday(new Date());
    const where: Prisma.KitchenEntryWhereInput = {
      businessDate: date,
      ...(query.q
        ? {
            OR: [
              {
                docketRef: {
                  contains: query.q,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
              {
                order: {
                  number: {
                    contains: query.q,
                    mode: Prisma.QueryMode.insensitive,
                  },
                },
              },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.kitchenEntry.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: ENTRY_COLUMNS,
    });
    const total = await this.prisma.kitchenEntry.count({ where });
    const all = await this.prisma.kitchenEntry.findMany({
      where,
      select: { lines: true },
    });
    const portions = all
      .flatMap((row) => parseKitchenLines(row.lines))
      .reduce((sum, line) => sum + line.qty, 0);

    const data: KitchenEntryResponse[] = [];
    for (const row of rows) data.push(await this.toResponse(this.prisma, row));

    return { data, page, pageSize, total, portions };
  }

  /** `GET /staff/kitchen/days/:date`: whether a kitchen day is closed. */
  async day(dateText: string): Promise<KitchenDayResponse> {
    const date = parseIsoDate(dateText);

    if (date === null) {
      throw new BadRequestException(
        'date must be a real calendar date (YYYY-MM-DD).',
      );
    }

    return this.dayOf(this.prisma, date);
  }

  /**
   * `kitchen.close`: close today's kitchen day, once. Later saves for the
   * day are managers' corrections with a reason. Guest bills stay payable:
   * nothing on the till reads this.
   *
   * The day's lock is taken exclusively first, so the close waits for any
   * save that checked the day open, and a save that starts after it sees
   * the day closed; a second close waits and then finds the first one's
   * row (409). The unique date answers the same 409 if the lock were ever
   * skipped.
   */
  async close(
    actor: StaffPrincipal,
    dateText: string,
    ipAddress: string,
  ): Promise<KitchenDayResponse> {
    const today = formatIsoDate(watToday(new Date()));

    if (dateText !== today) {
      throw new BadRequestException(KITCHEN_CLOSE_TODAY_MESSAGE);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const closed = await this.lockDays(tx, [today], 'exclusive');

        if (closed.has(today)) {
          throw new ConflictException(KITCHEN_CLOSED_MESSAGE);
        }

        const businessDate = parseIsoDate(today)!;

        await tx.kitchenDayClosed.create({
          data: { businessDate, closedById: actor.id },
          select: { id: true },
        });

        await this.audit.record(
          {
            actor: staffActor(actor),
            action: 'kitchen.close',
            ref: today,
            after: 'Closed',
            ipAddress,
          },
          tx,
        );

        return this.dayOf(tx, businessDate);
      });
    } catch (error) {
      if (uniqueViolationTargets(error).includes('businessDate')) {
        throw new ConflictException(KITCHEN_CLOSED_MESSAGE);
      }

      throw error;
    }
  }

  /**
   * Take each kitchen day's advisory lock (in date order, so two saves
   * cannot wait on each other), then answer which of the days are closed.
   */
  private async lockDays(
    tx: Tx,
    dates: readonly string[],
    mode: 'shared' | 'exclusive',
  ): Promise<Set<string>> {
    const days = [...new Set(dates)].sort();

    for (const day of days) {
      if (mode === 'shared') {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(
          hashtext(${KITCHEN_DAY_LOCK}), hashtext(${day}))`;
      } else {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(
          hashtext(${KITCHEN_DAY_LOCK}), hashtext(${day}))`;
      }
    }

    const rows = await tx.kitchenDayClosed.findMany({
      where: { businessDate: { in: days.map((day) => parseIsoDate(day)!) } },
      select: { businessDate: true },
    });

    return new Set(rows.map((row) => formatIsoDate(row.businessDate)));
  }

  /** Refuse any line whose item is missing or is not a Kitchen portion. */
  private async assertKitchenPortions(
    tx: Tx,
    lines: readonly KitchenLine[],
  ): Promise<void> {
    if (lines.length === 0) return;

    const items = await tx.stockItem.findMany({
      where: { id: { in: lines.map((line) => line.stockItemId) } },
      select: { id: true, kind: true },
    });
    const kinds = new Map(items.map((item) => [item.id, item.kind]));

    for (const line of lines) {
      if (kinds.get(line.stockItemId) !== StockKind.KITCHEN) {
        throw new BadRequestException(KITCHEN_PORTION_MESSAGE);
      }
    }
  }

  private async dayOf(
    client: Pick<Tx, 'kitchenDayClosed'>,
    businessDate: Date,
  ): Promise<KitchenDayResponse> {
    const row = await client.kitchenDayClosed.findUnique({
      where: { businessDate },
      select: { createdAt: true, closedBy: { select: { name: true } } },
    });
    const date = formatIsoDate(businessDate);

    return {
      businessDate: date,
      closed: row !== null,
      closedAt: row?.createdAt.toISOString() ?? null,
      closedByName: row?.closedBy.name ?? null,
      locked: row !== null || date !== formatIsoDate(watToday(new Date())),
    };
  }

  /** An entry as the API answers it, each portion with its name and unit. */
  private async toResponse(
    client: Reader,
    row: EntryRow,
  ): Promise<KitchenEntryResponse> {
    return {
      id: row.id,
      docketRef: row.docketRef,
      orderId: row.orderId,
      orderNumber: row.order.number,
      revision: row.revision,
      businessDate: formatIsoDate(row.businessDate),
      lines: await namedLines(client, parseKitchenLines(row.lines)),
      staffId: row.staffId,
      staffName: row.staff.name,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    };
  }
}

/** Kitchen lines with each item's name and unit, in the lines' order. */
export async function namedLines(
  client: Reader,
  lines: readonly KitchenLine[],
): Promise<KitchenLineResponse[]> {
  if (lines.length === 0) return [];

  const items = await client.stockItem.findMany({
    where: { id: { in: [...new Set(lines.map((line) => line.stockItemId))] } },
    select: { id: true, name: true, unit: true },
  });
  const byId = new Map(items.map((item) => [item.id, item]));

  return lines.map((line) => ({
    stockItemId: line.stockItemId,
    stockItemName: byId.get(line.stockItemId)?.name ?? '',
    unit: byId.get(line.stockItemId)?.unit ?? '',
    qty: line.qty,
  }));
}

/**
 * What an audit row records of an entry: its order, revision and date, and
 * each portion by name. The history then reads "Business Date changed from
 * … to …." and "Lines updated (n)." (the revision and the lines are
 * described by the sentences' own rules).
 */
function auditShape(entry: KitchenEntryResponse) {
  return {
    order: entry.orderNumber,
    revision: entry.revision,
    businessDate: entry.businessDate,
    lines: entry.lines.map((line) => ({
      item: line.stockItemName,
      qty: line.qty,
    })),
  };
}
