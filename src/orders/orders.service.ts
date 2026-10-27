import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Department,
  OrderChannel,
  OrderStatus,
  Prisma,
  ReservationStatus,
} from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { formatIsoDate } from '../common/calendar-date';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { watToday } from '../common/wat';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import { drawNumber, SEQUENCES } from '../prisma/sequences';
import { docketItem, sameDocketItems, type DocketItem } from './docket-items';
import { DocketsService } from './dockets.service';
import {
  OrderListFilter,
  OrderListState,
  type ConfirmOrderRequest,
  type CreateOrderRequest,
  type OrderListQuery,
  type SetOrderLineRequest,
  type UpdateOrderDetailsRequest,
} from './dto/order.request';
import type {
  OrderConfirmResponse,
  OrderFilterCountsResponse,
  OrderPageResponse,
  OrderResponse,
  OrderSummaryResponse,
  ReservationCreditResponse,
} from './dto/order.response';
import {
  BAR_NO_DOCKETS_MESSAGE,
  BELOW_PAID_MESSAGE,
  CONFIRM_EMPTY_MESSAGE,
  CONFIRM_OPEN_MESSAGE,
  ORDER_NOT_FOUND_MESSAGE,
  TABLE_MESSAGE,
} from './order-messages';
import {
  assertDepartmentAllowed,
  assertEditable,
  isEditable,
  lineProblem,
  UNSETTLED_ORDER_STATUSES,
} from './order-rules';
import { balanceDueKobo, orderTotals } from './order-totals';

type Tx = Prisma.TransactionClient;

/** Either the base client or a command's transaction. */
type Reader = Tx | CncPrismaService;

/** The columns an order is judged and answered from. */
const ORDER_COLUMNS = {
  id: true,
  number: true,
  department: true,
  channel: true,
  tableId: true,
  label: true,
  guest: true,
  businessDate: true,
  status: true,
  revision: true,
  vatBps: true,
  serviceBps: true,
  discountKobo: true,
  depositKobo: true,
  reservationId: true,
  notes: true,
  settledAt: true,
  openedById: true,
  createdAt: true,
  version: true,
} satisfies Prisma.OrderSelect;

export type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_COLUMNS }>;

const LINE_COLUMNS = {
  id: true,
  menuItemId: true,
  name: true,
  option: true,
  qty: true,
  unitPriceKobo: true,
  department: true,
} satisfies Prisma.OrderLineSelect;

type LineRow = Prisma.OrderLineGetPayload<{ select: typeof LINE_COLUMNS }>;

/** A bill something has been paid against (the demo's `paidSoFar > 0`). */
const PART_PAID: Prisma.OrderWhereInput = {
  payments: { some: { reversed: false, amountKobo: { gt: 0 } } },
};

/** What the history shows of a bill's lines: dish, choice, quantity, price. */
function auditItems(lines: readonly LineRow[]) {
  return lines.map((line) => ({
    name: line.name,
    option: line.option,
    qty: line.qty,
    unitPriceKobo: line.unitPriceKobo,
  }));
}

/**
 * Point of Sale's bills and lines (plan §5.4, §7.1, §7.2; cards C4-3 and
 * C4-4): open an order, set a line, change the guest and notes, confirm to
 * the kitchen, and the till's reads. Payments, settlement and the manager
 * corrections (C4-5) are `OrderPaymentsService`'s and build on
 * `claimOrder`, `lines` and `readOrder`.
 *
 * Every command is one transaction (A6) that claims the order's `version`
 * first (A8), so its row stays locked while the command runs, and writes
 * its audit row in it.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
    private readonly dockets: DocketsService,
  ) {}

  /**
   * The demo's `order()` for a command: the order exists (404), a
   * Bartender reaches Bar orders only (403), and then the write's
   * `version` is claimed, which locks the row for the rest of the
   * transaction. The department never changes, so reading it before the
   * claim is safe. Returns the order as locked.
   */
  async claimOrder(
    tx: Tx,
    actor: StaffPrincipal,
    id: string,
    version: number,
  ): Promise<OrderRow> {
    const found = await tx.order.findUnique({
      where: { id },
      select: { department: true },
    });

    if (found === null) throw new NotFoundException(ORDER_NOT_FOUND_MESSAGE);

    assertDepartmentAllowed(actor.role, found.department);

    await claimVersion(tx, {
      table: 'Order',
      id,
      version,
      notFound: ORDER_NOT_FOUND_MESSAGE,
    });

    return tx.order.findUniqueOrThrow({ where: { id }, select: ORDER_COLUMNS });
  }

  /** `GET /staff/orders/:id`. */
  async detail(actor: StaffPrincipal, id: string): Promise<OrderResponse> {
    const found = await this.prisma.order.findUnique({
      where: { id },
      select: { department: true },
    });

    if (found === null) throw new NotFoundException(ORDER_NOT_FOUND_MESSAGE);

    assertDepartmentAllowed(actor.role, found.department);

    return this.readOrder(this.prisma, id);
  }

  /**
   * `order.create`: a new bill, `CNCR-` or `CNCB-` from its department's
   * sequence (D29), on a table or none, with today's business date and the
   * VAT and service rates of the moment (a later rate change applies to
   * new bills only). Runs inside the idempotency service's transaction.
   */
  async create(
    tx: Tx,
    actor: StaffPrincipal,
    request: CreateOrderRequest,
    ipAddress: string,
  ): Promise<OrderResponse> {
    assertDepartmentAllowed(actor.role, request.department);

    const tableId = request.tableId ? request.tableId : null;
    const table =
      tableId === null
        ? null
        : await tx.diningTable.findUnique({
            where: { id: tableId },
            select: { id: true, name: true, active: true },
          });

    if (tableId !== null && (table === null || !table.active)) {
      throw new BadRequestException(TABLE_MESSAGE);
    }

    const settings = await tx.settings.findUniqueOrThrow({
      where: { singleton: true },
      select: { vatBps: true, serviceBps: true },
    });
    const sequence =
      request.department === Department.RESTAURANT
        ? 'orderRestaurant'
        : 'orderBar';
    const number = await drawNumber(tx, sequence);
    const label =
      request.label ||
      table?.name ||
      `Order ${Number(number.slice(SEQUENCES[sequence].prefix.length))}`;
    const today = watToday(new Date());

    const order = await tx.order.create({
      data: {
        number,
        department: request.department,
        channel: OrderChannel.POS,
        tableId,
        label,
        guest: request.guest ?? '',
        businessDate: today,
        vatBps: settings.vatBps,
        serviceBps: settings.serviceBps,
        openedById: actor.id,
      },
      select: { id: true },
    });

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'order.create',
        ref: number,
        after: {
          department: request.department,
          table: table?.name ?? null,
          label,
          guest: request.guest ?? '',
          businessDate: formatIsoDate(today),
          vatBps: settings.vatBps,
          serviceBps: settings.serviceBps,
        },
        ipAddress,
      },
      tx,
    );

    return this.readOrder(tx, order.id);
  }

  /**
   * `order.quantity`: set one line (a dish plus its option) to an absolute
   * quantity; zero removes it (plan §7.1 step 2).
   *
   * - Only an open order of today takes changes (`allowOrder`).
   * - The dish must be of the order's department and Available for Sale,
   *   except that a line may always be set to zero.
   * - A dish with a choice needs one of its options; one without takes
   *   none. Each option is its own line.
   * - A new line snapshots the dish's name and current price; an existing
   *   line keeps the price it was added at (a price change applies to new
   *   lines only).
   */
  async setLine(
    actor: StaffPrincipal,
    id: string,
    request: SetOrderLineRequest,
    ipAddress: string,
  ): Promise<OrderResponse> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.claimOrder(tx, actor, id, request.version);

      assertEditable(order, watToday(new Date()));

      const item = await tx.menuItem.findUnique({
        where: { id: request.menuItemId },
        select: {
          id: true,
          name: true,
          department: true,
          active: true,
          priceKobo: true,
          choiceLabel: true,
          choiceOptions: true,
        },
      });
      const option = request.option ?? '';
      const problem = lineProblem(item, order.department, option, request.qty);

      if (problem !== null || item === null) {
        throw new BadRequestException(problem);
      }

      const before = await this.lines(tx, id);
      const existing = before.find(
        (line) => line.menuItemId === item.id && line.option === option,
      );

      if (request.qty === 0) {
        if (existing) await tx.orderLine.delete({ where: { id: existing.id } });
      } else if (existing) {
        await tx.orderLine.update({
          where: { id: existing.id },
          data: { qty: request.qty },
        });
      } else {
        await tx.orderLine.create({
          data: {
            orderId: id,
            menuItemId: item.id,
            name: item.name,
            option,
            qty: request.qty,
            unitPriceKobo: item.priceKobo,
            department: item.department,
          },
        });
      }

      const after = await this.lines(tx, id);

      await this.assertCoversPaid(tx, order, after);

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'order.quantity',
          ref: order.number,
          before: { items: auditItems(before) },
          after: { items: auditItems(after) },
          ipAddress,
        },
        tx,
      );

      return this.readOrder(tx, id);
    });
  }

  /**
   * `order.details`: the guest's name and the order notes, on an open
   * order of today. Only the fields sent change (the demo blanked a field
   * left out; the screen always sends both).
   */
  async updateDetails(
    actor: StaffPrincipal,
    id: string,
    request: UpdateOrderDetailsRequest,
    ipAddress: string,
  ): Promise<OrderResponse> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.claimOrder(tx, actor, id, request.version);

      assertEditable(order, watToday(new Date()));

      const guest = request.guest ?? order.guest;
      const notes = request.notes ?? order.notes;

      await tx.order.update({ where: { id }, data: { guest, notes } });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'order.details',
          ref: order.number,
          before: { guest: order.guest, notes: order.notes },
          after: { guest, notes },
          ipAddress,
        },
        tx,
      );

      return this.readOrder(tx, id);
    });
  }

  /**
   * `order.confirm`: send a Restaurant bill to the kitchen (plan §7.1 step
   * 3). Writes docket revision n+1 (`KOT-<number>`) holding the full list
   * of lines and the order notes, dated with the order's business date, so
   * a carried order confirms its frozen items after midnight under its own
   * day. When nothing changed since the latest docket, that docket is
   * returned to print again and no revision is written. Nothing moves
   * stock: the kitchen records its own portions (C4-6).
   */
  async confirm(
    actor: StaffPrincipal,
    id: string,
    request: ConfirmOrderRequest,
    ipAddress: string,
  ): Promise<OrderConfirmResponse> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.claimOrder(tx, actor, id, request.version);

      if (order.status !== OrderStatus.OPEN) {
        throw new ConflictException(CONFIRM_OPEN_MESSAGE);
      }

      const lines = await this.lines(tx, id);

      if (lines.length === 0) {
        throw new ConflictException(CONFIRM_EMPTY_MESSAGE);
      }

      if (order.department !== Department.RESTAURANT) {
        throw new ConflictException(BAR_NO_DOCKETS_MESSAGE);
      }

      const items: DocketItem[] = lines.map(docketItem);
      const latest = await this.dockets.latestForOrder(tx, id, order.number);

      if (
        latest !== null &&
        order.revision > 0 &&
        sameDocketItems(items, latest.items)
      ) {
        await this.audit.record(
          {
            actor: staffActor(actor),
            action: 'order.confirm',
            ref: order.number,
            after: { docket: latest.ref, reprint: true },
            ipAddress,
          },
          tx,
        );

        return {
          reprint: true,
          docket: latest,
          order: await this.readOrder(tx, id),
        };
      }

      const revision = order.revision + 1;
      const docket = await this.dockets.write(tx, {
        orderId: id,
        orderNumber: order.number,
        revision,
        businessDate: order.businessDate,
        items,
        notes: order.notes,
        staffId: actor.id,
        channel: order.channel,
      });

      await tx.order.update({ where: { id }, data: { revision } });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'order.confirm',
          ref: order.number,
          after: {
            docket: docket.ref,
            revision,
            ...(order.notes ? { notes: order.notes } : {}),
            items: auditItems(lines),
          },
          ipAddress,
        },
        tx,
      );

      return { reprint: false, docket, order: await this.readOrder(tx, id) };
    });
  }

  /**
   * `GET /staff/orders`: one department's bills, by state and the till's
   * filter chips, with each bill's total, money received and balance, and
   * the chip counts. A Bartender reads the Bar only.
   */
  async list(
    actor: StaffPrincipal,
    query: OrderListQuery,
  ): Promise<OrderPageResponse> {
    assertDepartmentAllowed(actor.role, query.department);

    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const state = query.state ?? OrderListState.ACTIVE;
    const today = watToday(new Date());
    const where: Prisma.OrderWhereInput = {
      department: query.department,
      AND: [
        stateWhere(state),
        filterWhere(query.filter ?? OrderListFilter.ALL, today),
        query.tableId ? { tableId: query.tableId } : {},
        query.q
          ? {
              OR: (['number', 'label', 'guest'] as const).map((field) => ({
                [field]: {
                  contains: query.q,
                  mode: Prisma.QueryMode.insensitive,
                },
              })),
            }
          : {},
      ],
    };

    const rows = await this.prisma.order.findMany({
      where,
      orderBy: [
        { createdAt: state === OrderListState.ACTIVE ? 'asc' : 'desc' },
        { id: 'asc' },
      ],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: ORDER_COLUMNS,
    });
    const total = await this.prisma.order.count({ where });
    const ids = rows.map((row) => row.id);

    const lines = await this.prisma.orderLine.findMany({
      where: { orderId: { in: ids } },
      select: { orderId: true, qty: true, unitPriceKobo: true },
    });
    const paid = await this.paidByOrder(this.prisma, ids);
    const tableIds = [
      ...new Set(rows.flatMap((row) => (row.tableId ? [row.tableId] : []))),
    ];
    const tables = await this.prisma.diningTable.findMany({
      where: { id: { in: tableIds } },
      select: { id: true, code: true },
    });
    const codeOf = new Map(tables.map((table) => [table.id, table.code]));

    const data: OrderSummaryResponse[] = rows.map((row) => {
      const own = lines.filter((line) => line.orderId === row.id);
      const totals = orderTotals({ ...row, lines: own });
      const paidKobo = paid.get(row.id) ?? 0;

      return {
        id: row.id,
        number: row.number,
        department: row.department,
        channel: row.channel,
        status: row.status,
        tableId: row.tableId,
        tableCode: row.tableId ? (codeOf.get(row.tableId) ?? null) : null,
        label: row.label,
        guest: row.guest,
        businessDate: formatIsoDate(row.businessDate),
        lineCount: own.length,
        totalKobo: totals.totalKobo,
        paidKobo,
        balanceKobo: balanceDueKobo(row.status, totals.dueKobo, paidKobo),
        partPaid: paidKobo > 0,
        createdAt: row.createdAt.toISOString(),
        version: row.version,
      };
    });

    return {
      data,
      page,
      pageSize,
      total,
      counts: await this.counts(query.department, today),
    };
  }

  /** The demo's chip counts, over the department's active bills. */
  private async counts(
    department: Department,
    today: Date,
  ): Promise<OrderFilterCountsResponse> {
    const count = (filter: OrderListFilter) =>
      this.prisma.order.count({
        where: {
          department,
          AND: [stateWhere(OrderListState.ACTIVE), filterWhere(filter, today)],
        },
      });

    return {
      all: await count(OrderListFilter.ALL),
      unsettled: await count(OrderListFilter.UNSETTLED),
      awaitingPayment: await count(OrderListFilter.AWAITING_PAYMENT),
      partPaid: await count(OrderListFilter.PART_PAID),
      previousDays: await count(OrderListFilter.PREVIOUS_DAYS),
    };
  }

  /** A bill's lines, in the order they were added. */
  lines(client: Reader, orderId: string): Promise<LineRow[]> {
    return client.orderLine.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: LINE_COLUMNS,
    });
  }

  /** Money received against one bill, reversed payments excluded (`paidSoFar`). */
  async paidSoFar(client: Reader, orderId: string): Promise<number> {
    const sum = await client.payment.aggregate({
      where: { orderId, reversed: false },
      _sum: { amountKobo: true },
    });

    return sum._sum.amountKobo ?? 0;
  }

  /**
   * Refuse (409) a bill whose due amount, with these lines and this
   * discount, would be less than the money already taken against it. A
   * reopened part-paid bill could otherwise be cut below its payments, and
   * then no settle (exact cover of a negative balance), cancel (part paid)
   * or reversal (not settled) could ever close it, nor its table be
   * released. Line changes, the discount and Proceed to Payment all check.
   */
  async assertCoversPaid(
    tx: Tx,
    order: OrderRow,
    lines: readonly { qty: number; unitPriceKobo: number }[],
    discountKobo: number = order.discountKobo,
  ): Promise<void> {
    const paidKobo = await this.paidSoFar(tx, order.id);

    if (paidKobo === 0) return;

    const { dueKobo } = orderTotals({ ...order, discountKobo, lines });

    if (dueKobo < paidKobo) throw new ConflictException(BELOW_PAID_MESSAGE);
  }

  /** Money received per bill, reversed payments excluded (`paidSoFar`). */
  private async paidByOrder(
    client: Reader,
    orderIds: string[],
  ): Promise<Map<string, number>> {
    if (orderIds.length === 0) return new Map();

    const sums = await client.payment.groupBy({
      by: ['orderId'],
      where: { orderId: { in: orderIds }, reversed: false },
      _sum: { amountKobo: true },
    });

    return new Map(sums.map((sum) => [sum.orderId, sum._sum.amountKobo ?? 0]));
  }

  /**
   * One bill as every order route answers it. Each relation is its own
   * query, awaited in turn, so it is safe on a transaction's one
   * connection (see *Data and migrations*).
   */
  async readOrder(client: Reader, id: string): Promise<OrderResponse> {
    const order = await client.order.findUniqueOrThrow({
      where: { id },
      select: ORDER_COLUMNS,
    });
    const lines = await this.lines(client, id);
    const table =
      order.tableId === null
        ? null
        : await client.diningTable.findUniqueOrThrow({
            where: { id: order.tableId },
            select: { id: true, code: true, name: true, venueId: true },
          });
    const venue =
      table === null
        ? null
        : await client.venue.findUniqueOrThrow({
            where: { id: table.venueId },
            select: { slug: true, staffName: true },
          });
    const openedBy =
      order.openedById === null
        ? null
        : await client.staff.findUnique({
            where: { id: order.openedById },
            select: { name: true },
          });
    const payments = await client.payment.findMany({
      where: { orderId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        number: true,
        method: true,
        amountKobo: true,
        sender: true,
        reference: true,
        part: true,
        reversed: true,
        staffId: true,
        businessDate: true,
        createdAt: true,
      },
    });
    const payers = await client.staff.findMany({
      where: {
        id: {
          in: payments.flatMap((payment) =>
            payment.staffId ? [payment.staffId] : [],
          ),
        },
      },
      select: { id: true, name: true },
    });
    const payerName = new Map(payers.map((staff) => [staff.id, staff.name]));
    const latestDocket = await this.dockets.latestForOrder(
      client,
      id,
      order.number,
    );
    const reservationCredits = await this.reservationCredits(
      client,
      order.tableId,
    );

    const totals = orderTotals({ ...order, lines });
    const paidKobo = payments
      .filter((payment) => !payment.reversed)
      .reduce((sum, payment) => sum + payment.amountKobo, 0);
    const today = watToday(new Date());

    return {
      id: order.id,
      number: order.number,
      department: order.department,
      channel: order.channel,
      status: order.status,
      table:
        table === null || venue === null
          ? null
          : {
              id: table.id,
              code: table.code,
              name: table.name,
              venueSlug: venue.slug,
              venueName: venue.staffName,
            },
      label: order.label,
      guest: order.guest,
      notes: order.notes,
      businessDate: formatIsoDate(order.businessDate),
      revision: order.revision,
      vatBps: order.vatBps,
      serviceBps: order.serviceBps,
      discountKobo: order.discountKobo,
      depositKobo: order.depositKobo,
      reservationId: order.reservationId,
      openedById: order.openedById,
      openedByName: openedBy?.name ?? null,
      createdAt: order.createdAt.toISOString(),
      settledAt: order.settledAt?.toISOString() ?? null,
      editable: isEditable(order, today),
      unsentChanges:
        order.status === OrderStatus.OPEN &&
        order.department === Department.RESTAURANT &&
        order.channel === OrderChannel.POS &&
        !sameDocketItems(lines.map(docketItem), latestDocket?.items ?? []),
      partPaid: paidKobo > 0,
      lines: lines.map((line) => ({
        id: line.id,
        menuItemId: line.menuItemId,
        name: line.name,
        option: line.option,
        qty: line.qty,
        unitPriceKobo: line.unitPriceKobo,
        lineTotalKobo: line.qty * line.unitPriceKobo,
        department: line.department,
      })),
      totals: {
        ...totals,
        paidKobo,
        balanceKobo: balanceDueKobo(order.status, totals.dueKobo, paidKobo),
      },
      payments: payments.map((payment) => ({
        id: payment.id,
        number: payment.number,
        method: payment.method,
        amountKobo: payment.amountKobo,
        sender: payment.sender,
        reference: payment.reference,
        part: payment.part,
        reversed: payment.reversed,
        staffName: payment.staffId
          ? (payerName.get(payment.staffId) ?? null)
          : null,
        businessDate: formatIsoDate(payment.businessDate),
        createdAt: payment.createdAt.toISOString(),
      })),
      latestDocket,
      reservationCredits,
      version: order.version,
    };
  }

  /**
   * The deposit credit still unused on this table's checked-in or
   * completed bookings (the demo's `available` list). Always empty until a
   * route sets a deposit (D38), and computed so settlement (C4-5) offers
   * exactly what the demo offered.
   */
  private async reservationCredits(
    client: Reader,
    tableId: string | null,
  ): Promise<ReservationCreditResponse[]> {
    if (tableId === null) return [];

    const bookings = await client.reservation.findMany({
      where: {
        tableId,
        status: {
          in: [ReservationStatus.CHECKED_IN, ReservationStatus.COMPLETED],
        },
        depositKobo: { gt: 0 },
      },
      orderBy: [{ businessDate: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        number: true,
        name: true,
        depositKobo: true,
        depositUsedKobo: true,
      },
    });

    return bookings
      .filter((booking) => booking.depositKobo > booking.depositUsedKobo)
      .map((booking) => ({
        reservationId: booking.id,
        number: booking.number,
        name: booking.name,
        availableKobo: booking.depositKobo - booking.depositUsedKobo,
      }));
  }
}

/** The list's state, as a where clause. */
function stateWhere(state: OrderListState): Prisma.OrderWhereInput {
  switch (state) {
    case OrderListState.ACTIVE:
      return { status: { in: UNSETTLED_ORDER_STATUSES } };
    case OrderListState.SETTLED:
      return { status: OrderStatus.SETTLED };
    case OrderListState.CANCELLED:
      return { status: OrderStatus.CANCELLED };
    case OrderListState.ALL:
      return {};
  }
}

/**
 * The demo's `fits`: Unsettled is open; Awaiting Payment is at Payment with
 * nothing paid; Part Paid has money received; Previous Days was opened
 * before today.
 */
function filterWhere(
  filter: OrderListFilter,
  today: Date,
): Prisma.OrderWhereInput {
  switch (filter) {
    case OrderListFilter.ALL:
      return {};
    case OrderListFilter.UNSETTLED:
      return { status: OrderStatus.OPEN };
    case OrderListFilter.AWAITING_PAYMENT:
      return { status: OrderStatus.PAYMENT, NOT: PART_PAID };
    case OrderListFilter.PART_PAID:
      return PART_PAID;
    case OrderListFilter.PREVIOUS_DAYS:
      return { businessDate: { lt: today } };
  }
}
