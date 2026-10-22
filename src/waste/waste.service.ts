import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  Prisma,
  StockLocation,
  StockMovementType,
  WasteStatus,
  type WasteReason,
} from '../../generated/cnc-client';
import type { ApprovalView } from '../approvals/approval-rules';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { ROLE_REFUSED_MESSAGE } from '../auth/staff-roles';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import {
  LIMITED_DECISIONS,
  MoneyControlService,
  OWN_RECORD_KINDS,
} from '../money-control/money-control.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import { drawNumber } from '../prisma/sequences';
import { StockLedgerService } from '../stock/stock-ledger.service';
import { locationHolds } from '../stock/stock-locations';
import { stockValueKobo } from '../stock/stock-value';
import type {
  ApproveWasteRequest,
  CreateWasteRequest,
  EditWasteRequest,
  RejectWasteRequest,
  WasteQuery,
  WasteStatusRequest,
} from './dto/waste.request';
import type { WastePageResponse, WasteResponse } from './dto/waste.response';
import {
  CREATE_ITEM_MESSAGE,
  CREATE_QTY_REASON_MESSAGE,
  EDIT_ITEM_MESSAGE,
  EDIT_QTY_REASON_MESSAGE,
  REVIEW_PENDING_WASTE_MESSAGE,
  WASTE_NOT_FOUND_MESSAGE,
  WASTE_VALUE_TOO_LARGE_MESSAGE,
} from './waste-messages';
import {
  fitsValueColumn,
  ownLocationProblem,
  qtyReasonProblem,
  statusMove,
  wasteLocationFor,
} from './waste-rules';

type Tx = Prisma.TransactionClient;

/** What the answers are read through: the pool, or a command's transaction. */
type Reader = Pick<Prisma.TransactionClient, 'stockItem' | 'staff'>;

/** What an entry is valued through: the pool, or a command's transaction. */
type ValueReader = Pick<
  Prisma.TransactionClient,
  'stockItem' | 'menuItem' | 'purchaseLine'
>;

/** The waste search: part of the number, the note or the item's name, any case. */
function wasteSearch(q: string): Prisma.WasteEntryWhereInput {
  const contains = { contains: q, mode: Prisma.QueryMode.insensitive };

  return {
    OR: [
      { number: contains },
      { note: contains },
      { stockItem: { name: contains } },
    ],
  };
}

/** The columns a waste entry is answered from, without its relations. */
const WASTE_COLUMNS = {
  id: true,
  number: true,
  location: true,
  stockItemId: true,
  qty: true,
  reason: true,
  note: true,
  status: true,
  valueKobo: true,
  createdAt: true,
  createdById: true,
  decidedById: true,
  version: true,
} satisfies Prisma.WasteEntrySelect;

type WasteRow = Prisma.WasteEntryGetPayload<{ select: typeof WASTE_COLUMNS }>;

/** The item columns a command needs: where it is held and what it is worth. */
const ITEM_COLUMNS = {
  id: true,
  name: true,
  kind: true,
  unit: true,
  pack: true,
  factor: true,
  menuItemId: true,
} satisfies Prisma.StockItemSelect;

type ItemRow = Prisma.StockItemGetPayload<{ select: typeof ITEM_COLUMNS }>;

/** Whether a value is one of the three stock locations. */
function isStockLocation(value: unknown): value is StockLocation {
  return (
    typeof value === 'string' &&
    (Object.values(StockLocation) as string[]).includes(value)
  );
}

/** What an audit row says about an entry: names, never ids. */
function auditFields(
  row: Pick<WasteRow, 'location' | 'qty' | 'reason' | 'note' | 'valueKobo'>,
  itemName: string,
) {
  return {
    location: row.location,
    item: itemName,
    qty: row.qty,
    reason: row.reason,
    note: row.note || null,
    valueKobo: row.valueKobo,
  };
}

/**
 * Waste (plan §4.6, §5.4, §7.8; card C5-4): the Kitchen, the Bar (a
 * Bartender, or a Cashier from the till) and the Store log what was lost
 * at their own location (`waste.create`); a manager approves it within the
 * Owner Approval Limit and the Daily Approval Limit, never their own
 * (`waste.approve`), or rejects it, and corrects an entry (`waste.edit`) or
 * its status (`waste.status`) with a reason.
 *
 * **Stock moves only on approval** (§7.8), and only through
 * `StockLedgerService`, under the waste number: an approval takes the
 * quantity (`WASTE`); a status change away from Approved returns it
 * (`WASTE_APPROVAL_CORRECTION`); a correction of an approved entry returns
 * the old quantity and takes the new (`WASTE_CORRECTION_RETURN`,
 * `WASTE_CORRECTION_DEDUCTION`).
 *
 * **The value is the coded formula until Q25 is answered**
 * (`stockValueKobo`, the demo's `wasteValue`): the entry's quantity valued
 * as it stands, at whatever location, so a Store write-off of one bag of
 * rice at ₦70,000 a bag of 50 portions is ₦1,400, as Q25 describes. It is
 * stored on the row when the entry is logged and corrected, and valued
 * afresh when it is approved (the demo values the decision as it is made),
 * so the row holds the value the decision was judged on.
 *
 * Every command after the create claims the entry's `version` first (A8)
 * and writes its audit row in the same transaction.
 */
@Injectable()
export class WasteService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
    private readonly money: MoneyControlService,
  ) {}

  /**
   * `GET /staff/waste`: newest first. Each role other than a manager reads
   * its own location's waste (`wasteLocationFor`), and asking for another
   * location is the role refusal; managers read every location, or the one
   * asked for.
   */
  async list(
    actor: StaffPrincipal,
    query: WasteQuery,
  ): Promise<WastePageResponse> {
    const scoped = wasteLocationFor(actor.role);

    if (
      scoped !== undefined &&
      query.location !== undefined &&
      query.location !== scoped
    ) {
      throw new ForbiddenException(ROLE_REFUSED_MESSAGE);
    }

    const location = scoped ?? query.location;
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const visible: Prisma.WasteEntryWhereInput =
      location === undefined ? {} : { location };
    const filters: Prisma.WasteEntryWhereInput[] = [visible];

    if (query.view === 'PENDING') filters.push({ status: WasteStatus.PENDING });
    if (query.view === 'HISTORY') {
      filters.push({ status: { not: WasteStatus.PENDING } });
    }

    if (query.q) filters.push(wasteSearch(query.q));

    const where: Prisma.WasteEntryWhereInput = { AND: filters };
    const rows = await this.prisma.wasteEntry.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: WASTE_COLUMNS,
    });
    const total = await this.prisma.wasteEntry.count({ where });
    const pendingCount = await this.prisma.wasteEntry.count({
      where: { ...visible, status: WasteStatus.PENDING },
    });

    return {
      data: await this.answerMany(this.prisma, rows),
      page,
      pageSize,
      total,
      pendingCount,
    };
  }

  /**
   * `waste.create`: the demo's order. The location (the DTO: "Choose a
   * stock location."), then the role's own location (403, the role's
   * sentence), then the quantity and reason, then an item the location
   * holds. The entry is Pending, and no stock moves until it is approved.
   * Runs inside the idempotency service's transaction: a retry after a
   * lost response replays the first entry instead of logging the loss
   * twice.
   */
  async create(
    tx: Tx,
    actor: StaffPrincipal,
    request: CreateWasteRequest,
    ipAddress: string,
  ): Promise<WasteResponse> {
    const location = request.location;
    const ownLocation = ownLocationProblem(actor.role, location);

    if (ownLocation !== null) throw new ForbiddenException(ownLocation);

    const problem = qtyReasonProblem(
      request.qty,
      request.reason,
      CREATE_QTY_REASON_MESSAGE,
    );

    if (problem !== null) throw new BadRequestException(problem);

    const item = await this.heldItem(tx, request.stockItemId, location);

    if (item === null) throw new BadRequestException(CREATE_ITEM_MESSAGE);

    // `qtyReasonProblem` has proved a whole quantity and a waste reason.
    const qty = request.qty as number;
    const reason = request.reason as WasteReason;
    const valueKobo = await stockValueKobo(tx, item, qty);

    if (!fitsValueColumn(valueKobo)) {
      throw new BadRequestException(CREATE_QTY_REASON_MESSAGE);
    }

    const row = await tx.wasteEntry.create({
      data: {
        number: await drawNumber(tx, 'waste'),
        location,
        stockItemId: item.id,
        qty,
        reason,
        note: request.note ?? '',
        valueKobo,
        createdById: actor.id,
      },
      select: WASTE_COLUMNS,
    });

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'waste.create',
        ref: row.number,
        after: auditFields(row, item.name),
        ipAddress,
      },
      tx,
    );

    return this.answer(tx, row);
  }

  /**
   * `waste.edit`: a manager corrects an entry's location, item, quantity,
   * reason and note, with a reason, in the demo's order: the entry, the
   * location and item, the quantity and reason, then the new value against
   * the Owner Approval Limit (a correction decides nothing, so it does not
   * count toward the day). On an approved entry the old quantity returns to
   * its location and the new quantity leaves the new one.
   */
  async edit(
    actor: StaffPrincipal,
    id: string,
    request: EditWasteRequest,
    ipAddress: string,
  ): Promise<WasteResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.claim(tx, id, request.version);
      const location = request.location;
      const item = isStockLocation(location)
        ? await this.heldItem(tx, request.stockItemId, location)
        : null;

      if (!isStockLocation(location) || item === null) {
        throw new BadRequestException(EDIT_ITEM_MESSAGE);
      }

      const problem = qtyReasonProblem(
        request.qty,
        request.wasteReason,
        EDIT_QTY_REASON_MESSAGE,
      );

      if (problem !== null) throw new BadRequestException(problem);

      // `qtyReasonProblem` has proved a whole quantity and a waste reason.
      const qty = request.qty as number;
      const reason = request.wasteReason as WasteReason;
      const valueKobo = await stockValueKobo(tx, item, qty);

      if (!fitsValueColumn(valueKobo)) {
        throw new BadRequestException(EDIT_QTY_REASON_MESSAGE);
      }

      await this.money.withinLimit(tx, actor, {
        amountKobo: valueKobo,
        what: LIMITED_DECISIONS.writeOff,
        action: 'waste.edit',
        ref: current.number,
      });

      if (current.status === WasteStatus.APPROVED) {
        await this.ledger.move(tx, {
          stockItemId: current.stockItemId,
          location: current.location,
          qty: current.qty,
          type: StockMovementType.WASTE_CORRECTION_RETURN,
          ref: current.number,
          staffId: actor.id,
        });
        await this.ledger.move(tx, {
          stockItemId: item.id,
          location,
          qty: -qty,
          type: StockMovementType.WASTE_CORRECTION_DEDUCTION,
          ref: current.number,
          staffId: actor.id,
        });
      }

      const oldItem = await tx.stockItem.findUniqueOrThrow({
        where: { id: current.stockItemId },
        select: { name: true },
      });
      const updated = await tx.wasteEntry.update({
        where: { id },
        data: {
          location,
          stockItemId: item.id,
          qty,
          reason,
          note: request.note ?? '',
          valueKobo,
        },
        select: WASTE_COLUMNS,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'waste.edit',
          ref: current.number,
          before: auditFields(current, oldItem.name),
          after: auditFields(updated, item.name),
          reason: request.reason,
          ipAddress,
        },
        tx,
      );

      return this.answer(tx, updated);
    });
  }

  /**
   * `waste.approve`: a manager approves a Pending entry. The demo's order:
   * the Owner Approval Limit, then the Daily Approval Limit (with the
   * ledger), then the own-record rule; the Owner is exempt from all three.
   * Then the quantity leaves its location (`WASTE`): a location that no
   * longer holds it refuses with "Insufficient … stock for …" and nothing
   * is approved.
   */
  async approve(
    actor: StaffPrincipal,
    id: string,
    request: ApproveWasteRequest,
    ipAddress: string,
  ): Promise<WasteResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.claimPending(tx, id, request.version);
      const valueKobo = await this.approvalRules(
        tx,
        actor,
        current,
        'waste.approve',
      );

      await this.takeStock(tx, actor, current, StockMovementType.WASTE, -1);

      const updated = await tx.wasteEntry.update({
        where: { id },
        data: {
          status: WasteStatus.APPROVED,
          decidedById: actor.id,
          valueKobo,
        },
        select: WASTE_COLUMNS,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'waste.approve',
          ref: current.number,
          before: { status: current.status },
          after: { status: updated.status, valueKobo },
          ipAddress,
        },
        tx,
      );

      return this.answer(tx, updated);
    });
  }

  /**
   * `waste.reject`: a manager rejects a Pending entry, their own included
   * (rejecting writes nothing off). No stock moves.
   */
  async reject(
    actor: StaffPrincipal,
    id: string,
    request: RejectWasteRequest,
    ipAddress: string,
  ): Promise<WasteResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.claimPending(tx, id, request.version);
      const updated = await tx.wasteEntry.update({
        where: { id },
        data: { status: WasteStatus.REJECTED, decidedById: actor.id },
        select: WASTE_COLUMNS,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'waste.reject',
          ref: current.number,
          before: { status: current.status },
          after: { status: updated.status },
          reason: request.reason ?? null,
          ipAddress,
        },
        tx,
      );

      return this.answer(tx, updated);
    });
  }

  /**
   * `waste.status`: a manager sets an entry's status, with a reason.
   * Reaching Approved from any other status is an approval: the limits and
   * the own-record rule apply, as in the demo, and the quantity leaves its
   * location. Leaving Approved returns the quantity
   * (`WASTE_APPROVAL_CORRECTION`). The same status again moves nothing and
   * is recorded, as in the demo.
   */
  async setStatus(
    actor: StaffPrincipal,
    id: string,
    request: WasteStatusRequest,
    ipAddress: string,
  ): Promise<WasteResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.claim(tx, id, request.version);
      const status = request.status;
      const move = statusMove(current.status, status);
      const valueKobo =
        status === WasteStatus.APPROVED && current.status !== status
          ? await this.approvalRules(tx, actor, current, 'waste.status')
          : current.valueKobo;

      if (move !== null) {
        await this.takeStock(tx, actor, current, move.type, move.sign);
      }

      const updated = await tx.wasteEntry.update({
        where: { id },
        data: {
          status,
          decidedById: status === WasteStatus.PENDING ? null : actor.id,
          valueKobo,
        },
        select: WASTE_COLUMNS,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'waste.status',
          ref: current.number,
          before: { status: current.status },
          after: { status: updated.status },
          reason: request.reason,
          ipAddress,
        },
        tx,
      );

      return this.answer(tx, updated);
    });
  }

  /**
   * The money rules on an approval, in the demo's order: `withinLimit` (the
   * Owner Approval Limit, then the day's, counted in the ledger), then
   * `notOwn`. The entry is valued afresh, as the demo values it at the
   * decision. A refusal rolls the ledger row back with the command.
   * Returns the value the decision was judged on.
   */
  private async approvalRules(
    tx: Tx,
    actor: StaffPrincipal,
    entry: WasteRow,
    action: string,
  ): Promise<number> {
    const valueKobo = await this.decisionValueKobo(tx, entry);

    // Before the limits, so every role gets the same answer: the Owner is
    // exempt from them and would otherwise reach the column as a 500.
    if (!fitsValueColumn(valueKobo)) {
      throw new ConflictException(WASTE_VALUE_TOO_LARGE_MESSAGE);
    }

    await this.money.withinLimit(tx, actor, {
      amountKobo: valueKobo,
      what: LIMITED_DECISIONS.writeOff,
      count: true,
      action,
      ref: entry.number,
    });
    this.money.notOwn(actor, entry.createdById, OWN_RECORD_KINDS.wasteEntry);

    return valueKobo;
  }

  /**
   * What an approval of the entry would be judged on now: its quantity
   * valued afresh by the coded formula (Q25), as `approvalRules` values it.
   * The approvals read (C5-8) shows the same figure, so the screen's
   * prediction and the command never value one entry two ways.
   */
  async decisionValueKobo(
    client: ValueReader,
    entry: Pick<WasteRow, 'stockItemId' | 'qty'>,
  ): Promise<number> {
    const item = await client.stockItem.findUniqueOrThrow({
      where: { id: entry.stockItemId },
      select: ITEM_COLUMNS,
    });

    return stockValueKobo(client, item, entry.qty);
  }

  /**
   * The Approvals screen's waste (C5-8): Pending entries oldest first (the
   * queue in the order it was logged), or decided ones newest first, at
   * every location, with the waste read's search. Managers only, through
   * `ApprovalsService`.
   */
  async approvalsPage(
    view: ApprovalView,
    q: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<{ data: WasteResponse[]; total: number }> {
    const pending = view === 'PENDING';
    const filters: Prisma.WasteEntryWhereInput[] = [
      pending
        ? { status: WasteStatus.PENDING }
        : { status: { not: WasteStatus.PENDING } },
    ];

    if (q) filters.push(wasteSearch(q));

    const where: Prisma.WasteEntryWhereInput = { AND: filters };
    const order = pending ? 'asc' : 'desc';
    const rows = await this.prisma.wasteEntry.findMany({
      where,
      orderBy: [{ createdAt: order }, { id: order }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: WASTE_COLUMNS,
    });

    return {
      data: await this.answerMany(this.prisma, rows),
      total: await this.prisma.wasteEntry.count({ where }),
    };
  }

  /** Entries awaiting review at every location: the managers' figure. */
  pendingCount(): Promise<number> {
    return this.prisma.wasteEntry.count({
      where: { status: WasteStatus.PENDING },
    });
  }

  /** Move an entry's quantity at its location, taken (−1) or returned (+1). */
  private async takeStock(
    tx: Tx,
    actor: StaffPrincipal,
    entry: WasteRow,
    type: StockMovementType,
    sign: -1 | 1,
  ): Promise<void> {
    await this.ledger.move(tx, {
      stockItemId: entry.stockItemId,
      location: entry.location,
      qty: sign * entry.qty,
      type,
      ref: entry.number,
      staffId: actor.id,
    });
  }

  /** The item a write-off names, if it exists and the location holds it. */
  private async heldItem(
    tx: Tx,
    stockItemId: unknown,
    location: StockLocation,
  ): Promise<ItemRow | null> {
    if (typeof stockItemId !== 'string' || stockItemId.trim() === '') {
      return null;
    }

    const item = await tx.stockItem.findUnique({
      where: { id: stockItemId },
      select: ITEM_COLUMNS,
    });

    return item !== null && locationHolds(item.kind, location) ? item : null;
  }

  /**
   * Claim the entry's version (the row lock the command runs under): 404
   * "Waste record not found." for an id that names nothing, 409 for a
   * stale version.
   */
  private async claim(tx: Tx, id: string, version: number): Promise<WasteRow> {
    await claimVersion(tx, {
      table: 'WasteEntry',
      id,
      version,
      notFound: WASTE_NOT_FOUND_MESSAGE,
    });

    return tx.wasteEntry.findUniqueOrThrow({
      where: { id },
      select: WASTE_COLUMNS,
    });
  }

  /** Claim the entry, then refuse it unless it is Pending (409). */
  private async claimPending(
    tx: Tx,
    id: string,
    version: number,
  ): Promise<WasteRow> {
    const current = await this.claim(tx, id, version);

    if (current.status !== WasteStatus.PENDING) {
      throw new ConflictException(REVIEW_PENDING_WASTE_MESSAGE);
    }

    return current;
  }

  private async answer(tx: Tx, row: WasteRow): Promise<WasteResponse> {
    const [answer] = await this.answerMany(tx, [row]);

    return answer;
  }

  /**
   * Entries as the routes answer them. Their items and people are separate
   * queries awaited in turn, never a nested select, so this is safe inside
   * a transaction (*Data and migrations*).
   */
  private async answerMany(
    client: Reader,
    rows: readonly WasteRow[],
  ): Promise<WasteResponse[]> {
    if (rows.length === 0) return [];

    const items = await client.stockItem.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.stockItemId))] } },
      select: { id: true, name: true, unit: true, pack: true },
    });
    const people = await client.staff.findMany({
      where: {
        id: {
          in: [
            ...new Set(
              rows.flatMap((row) =>
                row.decidedById === null
                  ? [row.createdById]
                  : [row.createdById, row.decidedById],
              ),
            ),
          ],
        },
      },
      select: { id: true, name: true },
    });
    const itemOf = new Map(items.map((item) => [item.id, item]));
    const nameOf = new Map(people.map((person) => [person.id, person.name]));

    return rows.map((row) => {
      const item = itemOf.get(row.stockItemId);

      return {
        id: row.id,
        number: row.number,
        location: row.location,
        stockItemId: row.stockItemId,
        stockItemName: item?.name ?? '',
        measure:
          (row.location === StockLocation.STORE ? item?.pack : item?.unit) ??
          '',
        qty: row.qty,
        reason: row.reason,
        note: row.note,
        status: row.status,
        valueKobo: row.valueKobo,
        createdAt: row.createdAt.toISOString(),
        createdById: row.createdById,
        createdByName: nameOf.get(row.createdById) ?? '',
        decidedById: row.decidedById,
        decidedByName:
          row.decidedById === null
            ? null
            : (nameOf.get(row.decidedById) ?? null),
        version: row.version,
      };
    });
  }
}
