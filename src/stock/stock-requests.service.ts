import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  Prisma,
  StaffRole,
  StockLocation,
  StockMovementType,
  StockRequestStatus,
} from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { ROLE_REFUSED_MESSAGE } from '../auth/staff-roles';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import {
  MoneyControlService,
  OWN_RECORD_KINDS,
} from '../money-control/money-control.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import { drawNumber } from '../prisma/sequences';
import { asId } from '../push/push-input-types';
import { PushQueueService, type PushTopics } from '../push/push-queue.service';
import type {
  CreateStockRequestRequest,
  IssueStockRequestRequest,
  RejectStockRequestRequest,
  StockRequestsQuery,
} from './dto/stock-requests.request';
import type {
  StockRequestIssueResponse,
  StockRequestPageResponse,
  StockRequestResponse,
} from './dto/stock-requests.response';
import { StockLedgerService } from './stock-ledger.service';
import {
  ISSUE_TYPE,
  locationHolds,
  scopedStockLocation,
} from './stock-locations';
import {
  ISSUE_ITEM_MESSAGE,
  ISSUE_LOCATION_MESSAGE,
  REQUEST_NOT_OPEN_MESSAGE,
  STOCK_REQUEST_NOT_FOUND_MESSAGE,
} from './stock-messages';
import {
  isOpenRequest,
  issueProblem,
  OPEN_REQUEST_STATUSES,
  requestLocationFor,
  statusAfterIssue,
} from './stock-request-rules';

type Tx = Prisma.TransactionClient;

/** The columns a request is answered from, without its relations. */
const REQUEST_COLUMNS = {
  id: true,
  number: true,
  location: true,
  stockItemId: true,
  qtyPacks: true,
  issuedPacks: true,
  status: true,
  note: true,
  rejectReason: true,
  createdAt: true,
  createdById: true,
  version: true,
} satisfies Prisma.StockRequestSelect;

type RequestRow = Prisma.StockRequestGetPayload<{
  select: typeof REQUEST_COLUMNS;
}>;

/** The item columns a request's answer carries. */
const ITEM_COLUMNS = {
  name: true,
  unit: true,
  pack: true,
  factor: true,
} satisfies Prisma.StockItemSelect;

type ItemRow = Prisma.StockItemGetPayload<{ select: typeof ITEM_COLUMNS }>;

/** One request as the routes answer it. */
function toResponse(
  row: RequestRow,
  item: ItemRow,
  createdByName: string,
): StockRequestResponse {
  return {
    id: row.id,
    number: row.number,
    location: row.location,
    stockItemId: row.stockItemId,
    stockItemName: item.name,
    unit: item.unit,
    pack: item.pack,
    factor: item.factor,
    qtyPacks: row.qtyPacks,
    issuedPacks: row.issuedPacks,
    remainingPacks: isOpenRequest(row.status)
      ? row.qtyPacks - row.issuedPacks
      : 0,
    status: row.status,
    note: row.note,
    rejectReason: row.rejectReason,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    createdByName,
    version: row.version,
  };
}

/**
 * Stock requests (plan §4.6, §5.4, §7.6; card C5-2): the Kitchen and the
 * Bar ask the Store for whole packs (`request.create`), and the Storekeeper
 * sends them, all or in part (`request.issue`), or declines what is left
 * (`request.reject`).
 *
 * Every command is one transaction (A6): it claims the request's
 * `version` first (A8), moves stock only through `StockLedgerService`, and
 * writes its audit row in the same transaction, under the request number.
 */
@Injectable()
export class StockRequestsService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly ledger: StockLedgerService,
    private readonly audit: AuditService,
    private readonly money: MoneyControlService,
    private readonly push: PushQueueService,
  ) {}

  /**
   * `GET /staff/stock/requests`: newest first. A Kitchen user reads the
   * Kitchen's requests and a Bartender the Bar's (asking for the other
   * location is the role refusal, as on the balances); the Storekeeper and
   * managers read both, or the one asked for.
   */
  async list(
    actor: StaffPrincipal,
    query: StockRequestsQuery,
  ): Promise<StockRequestPageResponse> {
    const scoped = scopedStockLocation(actor.role);

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
    const visible: Prisma.StockRequestWhereInput =
      location === undefined ? {} : { location };
    const where: Prisma.StockRequestWhereInput = {
      ...visible,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              {
                number: {
                  contains: query.q,
                  mode: Prisma.QueryMode.insensitive,
                },
              },
              {
                stockItem: {
                  name: {
                    contains: query.q,
                    mode: Prisma.QueryMode.insensitive,
                  },
                },
              },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.stockRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        ...REQUEST_COLUMNS,
        stockItem: { select: ITEM_COLUMNS },
        createdBy: { select: { name: true } },
      },
    });
    const total = await this.prisma.stockRequest.count({ where });
    const openCount = await this.prisma.stockRequest.count({
      where: { ...visible, status: { in: [...OPEN_REQUEST_STATUSES] } },
    });

    return {
      data: rows.map((row) =>
        toResponse(row, row.stockItem, row.createdBy.name),
      ),
      page,
      pageSize,
      total,
      openCount,
    };
  }

  /**
   * `request.create`: the Kitchen, a Bartender or a Cashier (for the Bar),
   * or a manager for either, asks the Store for whole packs of an item the
   * location holds. Runs inside the idempotency service's transaction: a
   * retry after a lost response replays the first request instead of
   * asking twice. The Store's push (C10, PS7) joins `pushes`, for the
   * controller to send after the commit.
   */
  async create(
    tx: Tx,
    actor: StaffPrincipal,
    request: CreateStockRequestRequest,
    ipAddress: string,
    pushes: PushTopics = [],
  ): Promise<StockRequestResponse> {
    const location = requestLocationFor(actor.role, request.location);

    if (location === null) {
      throw new BadRequestException(ISSUE_LOCATION_MESSAGE);
    }

    const item = await tx.stockItem.findUnique({
      where: { id: request.stockItemId },
      select: { id: true, kind: true, ...ITEM_COLUMNS },
    });

    if (item === null || !locationHolds(item.kind, location)) {
      throw new BadRequestException(ISSUE_ITEM_MESSAGE);
    }

    const row = await tx.stockRequest.create({
      data: {
        number: await drawNumber(tx, 'stockRequest'),
        location,
        stockItemId: item.id,
        qtyPacks: request.qty,
        note: request.note ?? '',
        createdById: actor.id,
      },
      select: REQUEST_COLUMNS,
    });

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'request.create',
        ref: row.number,
        after: {
          location,
          item: item.name,
          qtyPacks: row.qtyPacks,
          note: row.note || null,
        },
        ipAddress,
      },
      tx,
    );

    // The Store hears of it: the Storekeeper on duty, else every active
    // one, else the managers (D8); held off-hours for whoever is not at
    // work (D6). A request names one item, so the push counts one.
    pushes.push(
      await this.push.enqueueStaff(
        tx,
        'stock_request.new',
        () => ({ requestId: asId(row.id), location, itemCount: 1 }),
        { roles: [StaffRole.STOREKEEPER], except: [actor.id] },
      ),
    );

    return toResponse(row, item, actor.name);
  }

  /**
   * `request.issue`: the Storekeeper (or a manager) sends whole packs
   * against an open request, never one they asked for themselves (the
   * Owner excepted). The Store loses the packs and the request's location
   * gains packs × How Many in One (plan §7.6), both under the request
   * number; the request is Issued once every pack is sent.
   *
   * The demo's order: open, own record, then the packs. No
   * Idempotency-Key: a retry names the version the first attempt moved
   * and is refused as stale.
   */
  async issue(
    actor: StaffPrincipal,
    id: string,
    request: IssueStockRequestRequest,
    ipAddress: string,
  ): Promise<StockRequestIssueResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.claimOpen(tx, id, request.version);

      this.money.notOwn(
        actor,
        current.createdById,
        OWN_RECORD_KINDS.stockRequest,
      );

      const item = await tx.stockItem.findUniqueOrThrow({
        where: { id: current.stockItemId },
        select: ITEM_COLUMNS,
      });
      const problem = issueProblem(request.qty, current, item);

      if (problem !== null) throw new BadRequestException(problem);

      // `issueProblem` has proved a whole number above zero.
      const packs = request.qty as number;
      const units = packs * item.factor;
      const location = current.location as keyof typeof ISSUE_TYPE;

      const storeQty = await this.ledger.move(tx, {
        stockItemId: current.stockItemId,
        location: StockLocation.STORE,
        qty: -packs,
        type: ISSUE_TYPE[location],
        ref: current.number,
        staffId: actor.id,
      });
      const destinationQty = await this.ledger.move(tx, {
        stockItemId: current.stockItemId,
        location,
        qty: units,
        type: StockMovementType.STOCK_RECEIVED,
        ref: current.number,
        staffId: actor.id,
      });

      const issuedPacks = current.issuedPacks + packs;
      const updated = await tx.stockRequest.update({
        where: { id },
        data: {
          issuedPacks,
          status: statusAfterIssue(current.qtyPacks, issuedPacks),
        },
        select: REQUEST_COLUMNS,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'request.issue',
          ref: current.number,
          before: {
            issuedPacks: current.issuedPacks,
            status: current.status,
          },
          after: { issuedPacks: updated.issuedPacks, status: updated.status },
          ipAddress,
        },
        tx,
      );

      return {
        request: await this.answer(tx, updated, item),
        packs,
        units,
        storeQty: storeQty ?? 0,
        destinationQty: destinationQty ?? 0,
      };
    });
  }

  /**
   * `request.reject`: the Storekeeper (or a manager) declines what is left
   * of an open request, with a reason. Packs already sent stay sent; no
   * stock moves.
   */
  async reject(
    actor: StaffPrincipal,
    id: string,
    request: RejectStockRequestRequest,
    ipAddress: string,
  ): Promise<StockRequestResponse> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.claimOpen(tx, id, request.version);

      const updated = await tx.stockRequest.update({
        where: { id },
        data: {
          status: StockRequestStatus.REJECTED,
          rejectReason: request.reason,
        },
        select: REQUEST_COLUMNS,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'request.reject',
          ref: current.number,
          before: { status: current.status },
          after: { status: updated.status },
          reason: request.reason,
          ipAddress,
        },
        tx,
      );

      const item = await tx.stockItem.findUniqueOrThrow({
        where: { id: updated.stockItemId },
        select: ITEM_COLUMNS,
      });

      return this.answer(tx, updated, item);
    });
  }

  /**
   * Claim the request's version (the row lock the command runs under),
   * then refuse it unless it is still open: 404 for an id that names
   * nothing, 409 for a stale version or a closed request.
   */
  private async claimOpen(
    tx: Tx,
    id: string,
    version: number,
  ): Promise<RequestRow> {
    await claimVersion(tx, {
      table: 'StockRequest',
      id,
      version,
      notFound: STOCK_REQUEST_NOT_FOUND_MESSAGE,
    });

    const current = await tx.stockRequest.findUniqueOrThrow({
      where: { id },
      select: REQUEST_COLUMNS,
    });

    if (!isOpenRequest(current.status)) {
      throw new ConflictException(REQUEST_NOT_OPEN_MESSAGE);
    }

    return current;
  }

  /**
   * A request's answer inside a transaction: its requester's name is a
   * separate query, never a nested select (*Data and migrations*).
   */
  private async answer(
    tx: Tx,
    row: RequestRow,
    item: ItemRow,
  ): Promise<StockRequestResponse> {
    const staff = await tx.staff.findUniqueOrThrow({
      where: { id: row.createdById },
      select: { name: true },
    });

    return toResponse(row, item, staff.name);
  }
}
