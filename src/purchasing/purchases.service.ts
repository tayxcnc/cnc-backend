import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  PurchaseStatus,
  StockLocation,
  StockMovementType,
  TaskType,
} from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
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
import {
  closeOpenTasks,
  managerForTask,
  raiseAutomaticTask,
  storekeeperForTask,
} from '../tasks/automatic-tasks';
import type {
  ApprovePurchaseRequest,
  ArchivePurchaseRequest,
  CreatePurchaseRequest,
  EditPurchaseRequest,
  PurchaseLineRequest,
  PurchasesQuery,
  PurchaseStatusRequest,
  ReceivePurchaseRequest,
  RejectPurchaseRequest,
} from './dto/purchases.request';
import type {
  PurchasePageResponse,
  PurchaseReceiveResponse,
  PurchaseResponse,
} from './dto/purchases.response';
import {
  CLOSED_PURCHASE_STATUSES,
  correctionMoves,
  hasReceived,
  isLineCost,
  purchaseTotalKobo,
  receivedValueKobo,
  receiveTaskTitle,
  reviewTaskTitle,
  taskForStatus,
} from './purchase-rules';
import {
  ACTIVE_VENDOR_MESSAGE,
  ARCHIVE_ACTIVE_MESSAGE,
  CREATE_LINE_ITEM_COST_MESSAGE,
  EDIT_ACTIVE_MESSAGE,
  EDIT_LINE_ITEM_COST_MESSAGE,
  PURCHASE_NOT_FOUND_MESSAGE,
  RECEIVE_APPROVED_MESSAGE,
  REVIEW_PENDING_MESSAGE,
  STATUS_LOCKED_MESSAGE,
} from './purchasing-messages';

type Tx = Prisma.TransactionClient;

/** What the answers are read through: the pool, or a command's transaction. */
type Reader = Pick<
  Prisma.TransactionClient,
  'purchaseLine' | 'vendor' | 'stockItem' | 'staff'
>;

/** The columns a purchase is answered from, without its relations. */
const PURCHASE_COLUMNS = {
  id: true,
  number: true,
  vendorId: true,
  status: true,
  note: true,
  archived: true,
  createdAt: true,
  createdById: true,
  decidedById: true,
  version: true,
} satisfies Prisma.PurchaseSelect;

type PurchaseRow = Prisma.PurchaseGetPayload<{
  select: typeof PURCHASE_COLUMNS;
}>;

const LINE_COLUMNS = {
  id: true,
  purchaseId: true,
  position: true,
  stockItemId: true,
  vendorId: true,
  qtyPacks: true,
  costKobo: true,
  receivedPacks: true,
} satisfies Prisma.PurchaseLineSelect;

type LineRow = Prisma.PurchaseLineGetPayload<{ select: typeof LINE_COLUMNS }>;

/** A requisition line as a command checked it, ready to store. */
interface CheckedLine {
  stockItemId: string;
  itemName: string;
  vendorId: string;
  vendorName: string;
  qtyPacks: number;
  costKobo: number;
}

/** What an audit row says about a requisition's lines: names, never ids. */
function auditLines(lines: readonly CheckedLine[]) {
  return lines.map((line) => ({
    item: line.itemName,
    vendor: line.vendorName,
    qtyPacks: line.qtyPacks,
    costKobo: line.costKobo,
  }));
}

/** The vendor id a plain line object carries, or undefined. */
function lineVendorId(line: PurchaseLineRequest): string | undefined {
  const value = (line as unknown as Record<string, unknown>).vendorId;

  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Purchasing (plan §4.6, §5.4, §7.7; card C5-3): the Storekeeper raises a
 * requisition (`purchase.create`), a manager approves it within the Owner
 * Approval Limit and the Daily Approval Limit, never their own
 * (`purchase.approve`), or rejects it, and the Storekeeper receives it into
 * the Store (`purchase.receive`). Managers correct a requisition
 * (`purchase.edit`), its status (`purchase.status`) or remove it from
 * active work (`purchase.archive`), each with a reason.
 *
 * The automatic tasks (§7.7, R1): raising a requisition opens "Review
 * purchase …" for a manager; once it is Approved, by approval or by a
 * status correction, the review closes and "Receive goods for …" opens for
 * the Storekeeper; receiving and archiving close every open task on it.
 *
 * Every command after the create claims the purchase's `version` first
 * (A8), applies the money rules through `MoneyControlService`, moves stock
 * only through `StockLedgerService`, and writes its audit row in the same
 * transaction, under the purchase number.
 */
@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
    private readonly money: MoneyControlService,
  ) {}

  /** `GET /staff/purchases`: newest first, with the screen's three figures. */
  async list(query: PurchasesQuery): Promise<PurchasePageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const contains = (value: string) => ({
      contains: value,
      mode: Prisma.QueryMode.insensitive,
    });
    const filters: Prisma.PurchaseWhereInput[] = [];

    if (query.view === 'ACTIVE') {
      filters.push({
        archived: false,
        status: { notIn: [...CLOSED_PURCHASE_STATUSES] },
      });
    } else if (query.view === 'HISTORY') {
      filters.push({
        OR: [
          { archived: true },
          { status: { in: [...CLOSED_PURCHASE_STATUSES] } },
        ],
      });
    }

    if (query.q) {
      filters.push({
        OR: [
          { number: contains(query.q) },
          { note: contains(query.q) },
          { lines: { some: { vendor: { name: contains(query.q) } } } },
        ],
      });
    }

    const where: Prisma.PurchaseWhereInput = { AND: filters };
    const rows = await this.prisma.purchase.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: PURCHASE_COLUMNS,
    });
    const total = await this.prisma.purchase.count({ where });
    const awaitingApproval = await this.prisma.purchase.count({
      where: { status: PurchaseStatus.PENDING, archived: false },
    });
    const approvedNotReceived = await this.prisma.purchase.count({
      where: { status: PurchaseStatus.APPROVED, archived: false },
    });
    // A bigint sum (plan §10): a year of deliveries overflows an Int.
    const [received] = await this.prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("receivedPacks"::bigint * "costKobo"), 0)::bigint AS "total"
        FROM "PurchaseLine"`;

    return {
      data: await this.answerMany(this.prisma, rows),
      page,
      pageSize,
      total,
      counts: {
        awaitingApproval,
        approvedNotReceived,
        receivedValueKobo: Number(received.total),
      },
    };
  }

  /** `GET /staff/purchases/:id`. */
  async get(id: string): Promise<PurchaseResponse> {
    const row = await this.prisma.purchase.findUnique({
      where: { id },
      select: PURCHASE_COLUMNS,
    });

    if (row === null) throw new NotFoundException(PURCHASE_NOT_FOUND_MESSAGE);

    const [answer] = await this.answerMany(this.prisma, [row]);

    return answer;
  }

  /**
   * `purchase.create`: the Storekeeper (or a manager) raises a requisition,
   * Pending, with a review task for a manager. Every line names an active
   * vendor (its own, or the requisition's) and an item, at a cost per pack
   * above zero, checked line by line in the demo's order. Runs inside the
   * idempotency service's transaction: a retry after a lost response
   * replays the first requisition instead of raising a second.
   */
  async create(
    tx: Tx,
    actor: StaffPrincipal,
    request: CreatePurchaseRequest,
    ipAddress: string,
  ): Promise<PurchaseResponse> {
    const lines = await this.checkLines(tx, request.lines, {
      defaultVendorId: request.vendorId,
      itemCostMessage: CREATE_LINE_ITEM_COST_MESSAGE,
      vendorFirst: true,
    });
    const header = lines[0];
    const row = await tx.purchase.create({
      data: {
        number: await drawNumber(tx, 'purchase'),
        vendorId: header.vendorId,
        note: request.note ?? '',
        createdById: actor.id,
      },
      select: PURCHASE_COLUMNS,
    });

    await this.writeLines(tx, row.id, lines, false);
    await this.raiseTaskFor(tx, row, PurchaseStatus.PENDING, actor.id);

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'purchase.create',
        ref: row.number,
        after: {
          vendor: header.vendorName,
          lines: auditLines(lines),
          totalKobo: purchaseTotalKobo(lines),
          note: row.note || null,
        },
        ipAddress,
      },
      tx,
    );

    return this.answer(tx, row);
  }

  /**
   * `purchase.edit`: a manager corrects a requisition that is not archived,
   * with a reason. Both the old and the new totals are held to the Owner
   * Approval Limit (an edit decides nothing, so neither counts toward the
   * day). On a purchase with received goods the Store moves by each item's
   * new quantity less what was received (`PURCHASE_CORRECTION`), and the
   * new lines count as received in full.
   */
  async edit(
    actor: StaffPrincipal,
    id: string,
    request: EditPurchaseRequest,
    ipAddress: string,
  ): Promise<PurchaseResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.claim(tx, id, request.version);

      if (current.archived) throw new ConflictException(EDIT_ACTIVE_MESSAGE);

      const lines = await this.checkLines(tx, request.lines, {
        defaultVendorId: undefined,
        itemCostMessage: EDIT_LINE_ITEM_COST_MESSAGE,
        vendorFirst: false,
      });
      const oldLines = await this.linesOf(tx, id);

      for (const amountKobo of [
        purchaseTotalKobo(oldLines),
        purchaseTotalKobo(lines),
      ]) {
        await this.money.withinLimit(tx, actor, {
          amountKobo,
          what: LIMITED_DECISIONS.purchase,
          action: 'purchase.edit',
          ref: current.number,
        });
      }

      const received = hasReceived(oldLines);

      if (received) {
        for (const move of correctionMoves(oldLines, lines)) {
          await this.ledger.move(tx, {
            stockItemId: move.stockItemId,
            location: StockLocation.STORE,
            qty: move.qty,
            type: StockMovementType.PURCHASE_CORRECTION,
            ref: current.number,
            staffId: actor.id,
          });
        }
      }

      const before = await this.answer(tx, current);

      await tx.purchaseLine.deleteMany({ where: { purchaseId: id } });
      await this.writeLines(tx, id, lines, received);

      const updated = await tx.purchase.update({
        where: { id },
        data: { vendorId: lines[0].vendorId, note: request.note ?? '' },
        select: PURCHASE_COLUMNS,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'purchase.edit',
          ref: current.number,
          before: {
            lines: before.lines.map((line) => ({
              item: line.stockItemName,
              vendor: line.vendorName,
              qtyPacks: line.qtyPacks,
              costKobo: line.costKobo,
            })),
            totalKobo: before.totalKobo,
            note: before.note || null,
          },
          after: {
            lines: auditLines(lines),
            totalKobo: purchaseTotalKobo(lines),
            note: updated.note || null,
          },
          reason: request.reason,
          ipAddress,
        },
        tx,
      );

      return this.answer(tx, updated);
    });
  }

  /**
   * `purchase.approve`: a manager approves an active Pending requisition.
   * The demo's order: the Owner Approval Limit, then the Daily Approval
   * Limit (with the ledger), then the own-record rule; the Owner is exempt
   * from all three. The review task closes and the receive task opens for
   * the Storekeeper.
   */
  async approve(
    actor: StaffPrincipal,
    id: string,
    request: ApprovePurchaseRequest,
    ipAddress: string,
  ): Promise<PurchaseResponse> {
    return this.review(actor, id, request.version, PurchaseStatus.APPROVED, {
      ipAddress,
    });
  }

  /**
   * `purchase.reject`: a manager rejects an active Pending requisition,
   * their own included (rejecting spends nothing). The review task closes.
   */
  async reject(
    actor: StaffPrincipal,
    id: string,
    request: RejectPurchaseRequest,
    ipAddress: string,
  ): Promise<PurchaseResponse> {
    return this.review(actor, id, request.version, PurchaseStatus.REJECTED, {
      reason: request.reason,
      ipAddress,
    });
  }

  /**
   * `purchase.status`: a manager corrects the status of a requisition that
   * is neither archived nor received, with a reason. Moving it to Approved
   * is an approval: the limits and the own-record rule apply, as in the
   * demo. Corrected (§17, R1): the automatic tasks follow the new status as
   * they follow an approval, so Approved opens the receive task, and Pending
   * puts the review back.
   */
  async setStatus(
    actor: StaffPrincipal,
    id: string,
    request: PurchaseStatusRequest,
    ipAddress: string,
  ): Promise<PurchaseResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.claim(tx, id, request.version);
      const lines = await this.linesOf(tx, id);

      if (current.archived || hasReceived(lines)) {
        throw new ConflictException(STATUS_LOCKED_MESSAGE);
      }

      const status = request.status;
      const changed = status !== current.status;

      if (status === PurchaseStatus.APPROVED && changed) {
        await this.approvalRules(tx, actor, current, lines, 'purchase.status');
      }

      const updated = await tx.purchase.update({
        where: { id },
        data: {
          status,
          decidedById: status === PurchaseStatus.PENDING ? null : actor.id,
        },
        select: PURCHASE_COLUMNS,
      });

      if (changed) await this.moveTasks(tx, updated, actor.id);

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'purchase.status',
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
   * `purchase.archive`: a manager removes a requisition from active work,
   * with a reason. With nothing received it is also Cancelled; received
   * goods stay in the Store. Corrected (§17, R1): its open tasks close.
   */
  async archive(
    actor: StaffPrincipal,
    id: string,
    request: ArchivePurchaseRequest,
    ipAddress: string,
  ): Promise<PurchaseResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.claim(tx, id, request.version);

      if (current.archived) {
        throw new ConflictException(ARCHIVE_ACTIVE_MESSAGE);
      }

      const lines = await this.linesOf(tx, id);
      const updated = await tx.purchase.update({
        where: { id },
        data: {
          archived: true,
          ...(hasReceived(lines) ? {} : { status: PurchaseStatus.CANCELLED }),
        },
        select: PURCHASE_COLUMNS,
      });

      await closeOpenTasks(
        tx,
        { purchaseId: id, automaticOnly: false },
        actor.id,
      );

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'purchase.archive',
          ref: current.number,
          before: { archived: false, status: current.status },
          after: { archived: true, status: updated.status },
          reason: request.reason,
          ipAddress,
        },
        tx,
      );

      return this.answer(tx, updated);
    });
  }

  /**
   * `purchase.receive`: the Storekeeper (or a manager) receives an active
   * Approved requisition, all at once (D39). Each line's remaining packs
   * enter the Store (`PURCHASE_RECEIPT`, under the purchase number); the
   * requisition is Fulfilled and every open task on it closes. No
   * Idempotency-Key: a retry names the version the first attempt moved and
   * is refused as stale.
   */
  async receive(
    actor: StaffPrincipal,
    id: string,
    request: ReceivePurchaseRequest,
    ipAddress: string,
  ): Promise<PurchaseReceiveResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.claim(tx, id, request.version);

      if (current.archived || current.status !== PurchaseStatus.APPROVED) {
        throw new ConflictException(RECEIVE_APPROVED_MESSAGE);
      }

      const lines = await this.linesOf(tx, id);
      const storeQty: Record<string, number> = {};

      for (const line of lines) {
        const packs = line.qtyPacks - line.receivedPacks;

        if (packs === 0) continue;

        const balance = await this.ledger.move(tx, {
          stockItemId: line.stockItemId,
          location: StockLocation.STORE,
          qty: packs,
          type: StockMovementType.PURCHASE_RECEIPT,
          ref: current.number,
          staffId: actor.id,
        });

        await tx.purchaseLine.update({
          where: { id: line.id },
          data: { receivedPacks: line.qtyPacks },
        });

        storeQty[line.stockItemId] = balance ?? 0;
      }

      const updated = await tx.purchase.update({
        where: { id },
        data: { status: PurchaseStatus.FULFILLED },
        select: PURCHASE_COLUMNS,
      });

      await closeOpenTasks(
        tx,
        { purchaseId: id, automaticOnly: false },
        actor.id,
      );

      const purchase = await this.answer(tx, updated);

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'purchase.receive',
          ref: current.number,
          before: { status: current.status },
          after: {
            status: updated.status,
            receivedValueKobo: purchase.receivedValueKobo,
          },
          ipAddress,
        },
        tx,
      );

      return { purchase, storeQty };
    });
  }

  /** Approve or reject a Pending requisition: the shared half of both commands. */
  private review(
    actor: StaffPrincipal,
    id: string,
    version: number,
    status: typeof PurchaseStatus.APPROVED | typeof PurchaseStatus.REJECTED,
    extra: { reason?: string; ipAddress: string },
  ): Promise<PurchaseResponse> {
    const action =
      status === PurchaseStatus.APPROVED
        ? 'purchase.approve'
        : 'purchase.reject';

    return this.prisma.$transaction(async (tx) => {
      const current = await this.claim(tx, id, version);

      if (current.archived || current.status !== PurchaseStatus.PENDING) {
        throw new ConflictException(REVIEW_PENDING_MESSAGE);
      }

      if (status === PurchaseStatus.APPROVED) {
        await this.approvalRules(
          tx,
          actor,
          current,
          await this.linesOf(tx, id),
          action,
        );
      }

      const updated = await tx.purchase.update({
        where: { id },
        data: { status, decidedById: actor.id },
        select: PURCHASE_COLUMNS,
      });

      await this.moveTasks(tx, updated, actor.id);

      await this.audit.record(
        {
          actor: staffActor(actor),
          action,
          ref: current.number,
          before: { status: current.status },
          after: { status: updated.status },
          reason: extra.reason ?? null,
          ipAddress: extra.ipAddress,
        },
        tx,
      );

      return this.answer(tx, updated);
    });
  }

  /**
   * The money rules on an approval, in the demo's order: `withinLimit`
   * (the Owner Approval Limit, then the day's, counted in the ledger), then
   * `notOwn`. A refusal rolls the ledger row back with the command.
   */
  private async approvalRules(
    tx: Tx,
    actor: StaffPrincipal,
    purchase: PurchaseRow,
    lines: readonly LineRow[],
    action: string,
  ): Promise<void> {
    await this.money.withinLimit(tx, actor, {
      amountKobo: purchaseTotalKobo(lines),
      what: LIMITED_DECISIONS.purchase,
      count: true,
      action,
      ref: purchase.number,
    });
    this.money.notOwn(actor, purchase.createdById, OWN_RECORD_KINDS.purchase);
  }

  /**
   * The automatic tasks after a status change: the ones the old status
   * opened close, and the new status's task opens (`taskForStatus`).
   * Tasks a person linked to the purchase stay open until it is received
   * or archived, as in the demo.
   */
  private async moveTasks(
    tx: Tx,
    purchase: PurchaseRow,
    staffId: string,
  ): Promise<void> {
    await closeOpenTasks(
      tx,
      { purchaseId: purchase.id, automaticOnly: true },
      staffId,
    );
    await this.raiseTaskFor(tx, purchase, purchase.status, staffId);
  }

  /** Open the automatic task a status waits on, if it waits on one. */
  private async raiseTaskFor(
    tx: Tx,
    purchase: Pick<PurchaseRow, 'id' | 'number' | 'vendorId'>,
    status: PurchaseStatus,
    staffId: string,
  ): Promise<void> {
    const kind = taskForStatus(status);

    if (kind === 'REVIEW') {
      const vendor = await tx.vendor.findUniqueOrThrow({
        where: { id: purchase.vendorId },
        select: { name: true },
      });

      await raiseAutomaticTask(tx, {
        title: reviewTaskTitle(purchase.number, vendor.name),
        type: TaskType.PURCHASE,
        assignedToId: await managerForTask(tx, staffId),
        raisedById: staffId,
        purchaseId: purchase.id,
      });
    } else if (kind === 'RECEIVE') {
      await raiseAutomaticTask(tx, {
        title: receiveTaskTitle(purchase.number),
        type: TaskType.PURCHASE,
        assignedToId: await storekeeperForTask(tx, staffId),
        raisedById: staffId,
        purchaseId: purchase.id,
      });
    }
  }

  /**
   * Check a requisition's lines against the database, line by line, in the
   * demo's order: `purchase.create` checks the vendor and then the item and
   * cost, `purchase.edit` the other way round. The list's own rules
   * (empty, duplicates, quantities) were checked by the DTO.
   */
  private async checkLines(
    tx: Tx,
    lines: readonly PurchaseLineRequest[],
    rules: {
      defaultVendorId: string | undefined;
      itemCostMessage: string;
      vendorFirst: boolean;
    },
  ): Promise<CheckedLine[]> {
    const checked: CheckedLine[] = [];

    for (const line of lines) {
      const vendorCheck = async () => {
        const vendorId = lineVendorId(line) ?? rules.defaultVendorId;
        const vendor =
          vendorId === undefined
            ? null
            : await tx.vendor.findUnique({
                where: { id: vendorId },
                select: { id: true, name: true, isActive: true },
              });

        if (vendor === null || !vendor.isActive) {
          throw new BadRequestException(ACTIVE_VENDOR_MESSAGE);
        }

        return vendor;
      };
      const itemCheck = async () => {
        const item = await tx.stockItem.findUnique({
          where: { id: line.stockItemId },
          select: { id: true, name: true },
        });

        if (item === null || !isLineCost(line.costKobo)) {
          throw new BadRequestException(rules.itemCostMessage);
        }

        return item;
      };

      const vendor = rules.vendorFirst ? await vendorCheck() : undefined;
      const item = await itemCheck();
      const lineVendor = vendor ?? (await vendorCheck());

      checked.push({
        stockItemId: item.id,
        itemName: item.name,
        vendorId: lineVendor.id,
        vendorName: lineVendor.name,
        qtyPacks: line.qty,
        costKobo: line.costKobo,
      });
    }

    return checked;
  }

  /** Store a requisition's lines in the order they were sent. */
  private async writeLines(
    tx: Tx,
    purchaseId: string,
    lines: readonly CheckedLine[],
    received: boolean,
  ): Promise<void> {
    await tx.purchaseLine.createMany({
      data: lines.map((line, position) => ({
        purchaseId,
        position,
        stockItemId: line.stockItemId,
        vendorId: line.vendorId,
        qtyPacks: line.qtyPacks,
        costKobo: line.costKobo,
        receivedPacks: received ? line.qtyPacks : 0,
      })),
    });
  }

  /**
   * Claim the purchase's version (the row lock the command runs under):
   * 404 for an id that names nothing, 409 for a stale version.
   */
  private async claim(
    tx: Tx,
    id: string,
    version: number,
  ): Promise<PurchaseRow> {
    await claimVersion(tx, {
      table: 'Purchase',
      id,
      version,
      notFound: PURCHASE_NOT_FOUND_MESSAGE,
    });

    return tx.purchase.findUniqueOrThrow({
      where: { id },
      select: PURCHASE_COLUMNS,
    });
  }

  private linesOf(tx: Tx, purchaseId: string): Promise<LineRow[]> {
    return tx.purchaseLine.findMany({
      where: { purchaseId },
      orderBy: { position: 'asc' },
      select: LINE_COLUMNS,
    });
  }

  private async answer(tx: Tx, row: PurchaseRow): Promise<PurchaseResponse> {
    const [answer] = await this.answerMany(tx, [row]);

    return answer;
  }

  /**
   * Requisitions as the routes answer them. Their lines, vendors, items and
   * people are separate queries awaited in turn, never a nested select, so
   * this is safe inside a transaction (*Data and migrations*).
   */
  private async answerMany(
    client: Reader,
    rows: readonly PurchaseRow[],
  ): Promise<PurchaseResponse[]> {
    if (rows.length === 0) return [];

    const lines = await client.purchaseLine.findMany({
      where: { purchaseId: { in: rows.map((row) => row.id) } },
      orderBy: [{ purchaseId: 'asc' }, { position: 'asc' }],
      select: LINE_COLUMNS,
    });
    const vendors = await client.vendor.findMany({
      where: {
        id: {
          in: [
            ...new Set([
              ...rows.map((row) => row.vendorId),
              ...lines.map((line) => line.vendorId),
            ]),
          ],
        },
      },
      select: { id: true, name: true },
    });
    const items = await client.stockItem.findMany({
      where: {
        id: { in: [...new Set(lines.map((line) => line.stockItemId))] },
      },
      select: { id: true, name: true, pack: true },
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

    const vendorName = new Map(vendors.map((v) => [v.id, v.name]));
    const itemOf = new Map(items.map((i) => [i.id, i]));
    const nameOf = new Map(people.map((p) => [p.id, p.name]));

    return rows.map((row) => {
      const own = lines.filter((line) => line.purchaseId === row.id);

      return {
        id: row.id,
        number: row.number,
        vendorId: row.vendorId,
        vendorName: vendorName.get(row.vendorId) ?? '',
        status: row.status,
        note: row.note,
        archived: row.archived,
        createdAt: row.createdAt.toISOString(),
        createdById: row.createdById,
        createdByName: nameOf.get(row.createdById) ?? '',
        decidedById: row.decidedById,
        decidedByName:
          row.decidedById === null
            ? null
            : (nameOf.get(row.decidedById) ?? null),
        totalKobo: purchaseTotalKobo(own),
        receivedValueKobo: receivedValueKobo(own),
        lines: own.map((line) => ({
          id: line.id,
          position: line.position,
          stockItemId: line.stockItemId,
          stockItemName: itemOf.get(line.stockItemId)?.name ?? '',
          pack: itemOf.get(line.stockItemId)?.pack ?? '',
          vendorId: line.vendorId,
          vendorName: vendorName.get(line.vendorId) ?? '',
          qtyPacks: line.qtyPacks,
          costKobo: line.costKobo,
          receivedPacks: line.receivedPacks,
          totalKobo: line.qtyPacks * line.costKobo,
        })),
        version: row.version,
      };
    });
  }
}
