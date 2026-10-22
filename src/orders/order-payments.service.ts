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
  StockKind,
  StockLocation,
  StockMovementType,
} from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { watToday } from '../common/wat';
import {
  increaseKobo,
  LIMITED_DECISIONS,
  MoneyControlService,
  OWNER_ONLY_ACTIONS,
} from '../money-control/money-control.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { drawNumber } from '../prisma/sequences';
import { StockLedgerService } from '../stock/stock-ledger.service';
import {
  insufficientStockMessage,
  STOCK_ITEM_NOT_FOUND_MESSAGE,
} from '../stock/stock-messages';
import { docketItem, sameDocketItems } from './docket-items';
import { DocketsService } from './dockets.service';
import type {
  DiscountOrderRequest,
  OrderCorrectionRequest,
  PartPaymentRequest,
  ProceedToPaymentRequest,
  SettleOrderRequest,
} from './dto/payment.request';
import type { OrderCancelResponse, OrderResponse } from './dto/order.response';
import {
  CANCEL_PART_PAID_MESSAGE,
  CANCEL_STAGE_MESSAGE,
  DEPOSIT_INVALID_MESSAGE,
  DEPOSIT_RESERVATION_MESSAGE,
  DEPOSIT_USED_MESSAGE,
  DISCOUNT_INVALID_MESSAGE,
  DISCOUNT_STAGE_MESSAGE,
  PART_PAY_STAGE_MESSAGE,
  PAYMENT_CONFIRM_FIRST_MESSAGE,
  PAYMENT_EMPTY_MESSAGE,
  PAYMENT_OPEN_MESSAGE,
  REOPEN_PREVIOUS_DAY_MESSAGE,
  REOPEN_STAGE_MESSAGE,
  REVERSE_STAGE_MESSAGE,
  SETTLE_STAGE_MESSAGE,
} from './order-messages';
import { isEditable } from './order-rules';
import { orderTotals } from './order-totals';
import { type OrderRow, OrdersService } from './orders.service';
import { judgePayments, type TillPayment } from './payment-rules';

type Tx = Prisma.TransactionClient;

/** Which way a Bar bill's drinks move: out on a settle, back on a reversal. */
type BarStockDirection = 'sale' | 'reversal';

/**
 * Point of Sale's money (plan §5.4, §7.1 to §7.3; card C4-5): Proceed to
 * Payment, part payments, settlement with exact cover, and the manager's
 * and Owner's corrections (discount, cancel, reopen, reverse), with the Bar
 * stock a settlement takes and a reversal returns.
 *
 * Every command is one transaction that takes the bill with
 * `OrdersService.claimOrder` first (404, the Bartender rule, then the
 * `version`, A8), so the bill stays locked for the rest of the command,
 * and writes its audit row in it (A6). Part payments and settlement run in
 * the idempotency service's transaction (A9); the others in their own.
 *
 * **Exactly once.** A settle deducts a Bar bill's drinks and a reversal
 * returns them, each inside the transaction that changes the bill's state
 * under its claimed version: a second settle of the same bill names a
 * version the first moved (409, stale) or finds it no longer awaiting
 * payment (409), and a second reversal finds it no longer settled, so
 * neither can move stock twice. Stock moves only through
 * `StockLedgerService`.
 */
@Injectable()
export class OrderPaymentsService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
    private readonly orders: OrdersService,
    private readonly dockets: DocketsService,
    private readonly money: MoneyControlService,
    private readonly ledger: StockLedgerService,
  ) {}

  /**
   * `order.payment` (Proceed to Payment, plan §7.1 step 4): an open bill
   * with lines moves to awaiting payment, which locks its items. A
   * Restaurant bill's lines must equal its latest docket, so the guest
   * never pays for food the kitchen was not sent. Not held to the date: a
   * carried bill proceeds to payment after midnight.
   */
  async proceedToPayment(
    actor: StaffPrincipal,
    id: string,
    request: ProceedToPaymentRequest,
    ipAddress: string,
  ): Promise<OrderResponse> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.orders.claimOrder(
        tx,
        actor,
        id,
        request.version,
      );

      if (order.status !== OrderStatus.OPEN) {
        throw new ConflictException(PAYMENT_OPEN_MESSAGE);
      }

      const lines = await this.orders.lines(tx, id);

      if (lines.length === 0) {
        throw new ConflictException(PAYMENT_EMPTY_MESSAGE);
      }

      if (order.department === Department.RESTAURANT) {
        const latest = await this.dockets.latestForOrder(tx, id, order.number);

        if (!sameDocketItems(lines.map(docketItem), latest?.items ?? [])) {
          throw new ConflictException(PAYMENT_CONFIRM_FIRST_MESSAGE);
        }
      }

      await this.orders.assertCoversPaid(tx, order, lines);

      await tx.order.update({
        where: { id },
        data: { status: OrderStatus.PAYMENT },
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'order.payment',
          ref: order.number,
          before: { status: order.status },
          after: { status: OrderStatus.PAYMENT },
          ipAddress,
        },
        tx,
      );

      return this.orders.readOrder(tx, id);
    });
  }

  /**
   * `order.partPay`: money taken against a bill awaiting payment, together
   * less than its balance; the bill stays awaiting payment. Runs inside the
   * idempotency service's transaction (A9).
   */
  async partPay(
    tx: Tx,
    actor: StaffPrincipal,
    id: string,
    request: PartPaymentRequest,
    ipAddress: string,
  ): Promise<OrderResponse> {
    const order = await this.orders.claimOrder(tx, actor, id, request.version);

    if (order.status !== OrderStatus.PAYMENT) {
      throw new ConflictException(PART_PAY_STAGE_MESSAGE);
    }

    const lines = await this.orders.lines(tx, id);
    const totals = orderTotals({ ...order, lines });
    const paidKobo = await this.orders.paidSoFar(tx, id);
    const balanceKobo = totals.dueKobo - paidKobo;
    const judged = judgePayments(request.payments, {
      kind: 'part',
      balanceKobo,
    });

    if ('problem' in judged) throw new BadRequestException(judged.problem);

    const takenKobo = await this.record(tx, actor, order, judged.payments, {
      part: true,
    });

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'order.partPay',
        ref: order.number,
        before: { paidKobo },
        after: {
          paidKobo: paidKobo + takenKobo,
          balanceKobo: balanceKobo - takenKobo,
        },
        ipAddress,
      },
      tx,
    );

    return this.orders.readOrder(tx, id);
  }

  /**
   * `order.settle` (plan §7.1 step 5, §7.2, §7.3): the payments must cover
   * what is left exactly, the total less part payments and any deposit
   * credit. A Bar bill's drinks leave the Bar here, once, through the
   * ledger's conditional decrement: a Bar short of any drink refuses the
   * whole settlement (409 "Insufficient bar stock for …") and nothing is
   * recorded. Runs inside the idempotency service's transaction (A9).
   */
  async settle(
    tx: Tx,
    actor: StaffPrincipal,
    id: string,
    request: SettleOrderRequest,
    ipAddress: string,
  ): Promise<OrderResponse> {
    const order = await this.orders.claimOrder(tx, actor, id, request.version);

    if (order.status !== OrderStatus.PAYMENT) {
      throw new ConflictException(SETTLE_STAGE_MESSAGE);
    }

    const lines = await this.orders.lines(tx, id);
    const totals = orderTotals({ ...order, lines });
    const paidKobo = await this.orders.paidSoFar(tx, id);
    const depositKobo = request.depositKobo ?? 0;

    if (depositKobo > totals.totalKobo - paidKobo) {
      throw new BadRequestException(DEPOSIT_INVALID_MESSAGE);
    }

    const reservationId =
      depositKobo > 0
        ? await this.useDepositCredit(tx, order, request, depositKobo)
        : null;

    const judged = judgePayments(request.payments, {
      kind: 'settle',
      remainingKobo: totals.totalKobo - depositKobo - paidKobo,
    });

    if ('problem' in judged) throw new BadRequestException(judged.problem);

    const takenKobo = await this.record(tx, actor, order, judged.payments, {
      part: false,
    });

    if (order.department === Department.BAR) {
      await this.moveBarStock(tx, actor, order, 'sale');
    }

    const settledAt = new Date();

    await tx.order.update({
      where: { id },
      data: {
        status: OrderStatus.SETTLED,
        settledAt,
        depositKobo,
        reservationId,
      },
    });

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'order.settle',
        ref: order.number,
        before: {
          status: order.status,
          paidKobo,
          depositKobo: order.depositKobo,
        },
        after: {
          status: OrderStatus.SETTLED,
          paidKobo: paidKobo + takenKobo,
          depositKobo,
          settledAt: settledAt.toISOString(),
        },
        ipAddress,
      },
      tx,
    );

    return this.orders.readOrder(tx, id);
  }

  /**
   * `order.discount` (M+r; L, D on the increase only): the bill's whole
   * discount, set before Proceed to Payment on the bill's opening date, up
   * to its subtotal. The amount is checked against the Owner Approval Limit
   * and only what it adds to the bill's discount counts toward the
   * manager's Daily Approval Limit, as the demo counts it.
   */
  async discount(
    actor: StaffPrincipal,
    id: string,
    request: DiscountOrderRequest,
    ipAddress: string,
  ): Promise<OrderResponse> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.orders.claimOrder(
        tx,
        actor,
        id,
        request.version,
      );

      if (!isEditable(order, watToday(new Date()))) {
        throw new ConflictException(DISCOUNT_STAGE_MESSAGE);
      }

      const lines = await this.orders.lines(tx, id);
      const totals = orderTotals({ ...order, lines });

      if (request.amountKobo > totals.subtotalKobo) {
        throw new BadRequestException(DISCOUNT_INVALID_MESSAGE);
      }

      await this.orders.assertCoversPaid(tx, order, lines, request.amountKobo);

      await this.money.withinLimit(tx, actor, {
        amountKobo: request.amountKobo,
        what: LIMITED_DECISIONS.discount,
        count: true,
        countedKobo: increaseKobo(order.discountKobo, request.amountKobo),
        action: 'order.discount',
        ref: order.number,
      });

      await tx.order.update({
        where: { id },
        data: { discountKobo: request.amountKobo },
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'order.discount',
          ref: order.number,
          before: { discountKobo: order.discountKobo },
          after: { discountKobo: request.amountKobo },
          reason: request.reason,
          ipAddress,
        },
        tx,
      );

      return this.orders.readOrder(tx, id);
    });
  }

  /**
   * `order.cancel` (M+r): an open or awaiting-payment bill with no money
   * against it. A Restaurant bill the kitchen was sent gets a cancellation
   * docket, revision n+1 with no items, to print; the kitchen's own
   * entries are left alone. A bill with part payments is settled instead.
   */
  async cancel(
    actor: StaffPrincipal,
    id: string,
    request: OrderCorrectionRequest,
    ipAddress: string,
  ): Promise<OrderCancelResponse> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.orders.claimOrder(
        tx,
        actor,
        id,
        request.version,
      );

      if (
        order.status !== OrderStatus.OPEN &&
        order.status !== OrderStatus.PAYMENT
      ) {
        throw new ConflictException(CANCEL_STAGE_MESSAGE);
      }

      if ((await this.orders.paidSoFar(tx, id)) !== 0) {
        throw new ConflictException(CANCEL_PART_PAID_MESSAGE);
      }

      const sendsDocket =
        order.department === Department.RESTAURANT && order.revision > 0;
      const revision = sendsDocket ? order.revision + 1 : order.revision;
      const docket = sendsDocket
        ? await this.dockets.write(tx, {
            orderId: id,
            orderNumber: order.number,
            revision,
            businessDate: order.businessDate,
            items: [],
            notes: '',
            staffId: actor.id,
            channel: order.channel,
          })
        : null;

      await tx.order.update({
        where: { id },
        data: { status: OrderStatus.CANCELLED, revision },
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'order.cancel',
          ref: order.number,
          before: { status: order.status },
          after: {
            status: OrderStatus.CANCELLED,
            ...(docket ? { docket: docket.ref, revision } : {}),
          },
          reason: request.reason,
          ipAddress,
        },
        tx,
      );

      return { docket, order: await this.orders.readOrder(tx, id) };
    });
  }

  /**
   * `order.reopen` (M+r): a bill awaiting payment goes back to open so its
   * items can change, on its opening date only (a carried bill's items stay
   * frozen). Part payments stay on the bill, and no later change may bring
   * the bill below them (`OrdersService.assertCoversPaid`).
   */
  async reopen(
    actor: StaffPrincipal,
    id: string,
    request: OrderCorrectionRequest,
    ipAddress: string,
  ): Promise<OrderResponse> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.orders.claimOrder(
        tx,
        actor,
        id,
        request.version,
      );

      if (order.status !== OrderStatus.PAYMENT) {
        throw new ConflictException(REOPEN_STAGE_MESSAGE);
      }

      if (order.businessDate.getTime() !== watToday(new Date()).getTime()) {
        throw new ConflictException(REOPEN_PREVIOUS_DAY_MESSAGE);
      }

      await tx.order.update({
        where: { id },
        data: { status: OrderStatus.OPEN },
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'order.reopen',
          ref: order.number,
          before: { status: order.status },
          after: { status: OrderStatus.OPEN },
          reason: request.reason,
          ipAddress,
        },
        tx,
      );

      return this.orders.readOrder(tx, id);
    });
  }

  /**
   * `order.reverse` (O+r): a settled till bill goes back to awaiting
   * payment. Every payment on it is marked reversed (kept, never deleted),
   * a Bar bill's drinks return to the Bar, and deposit credit it took goes
   * back to its booking. Settling it again takes fresh payments.
   *
   * The demo's `ownerOnly('reverse a paid bill')` comes first, before the
   * bill is even looked up, as the demo checks it (D35: the Owner only).
   */
  async reverse(
    actor: StaffPrincipal,
    id: string,
    request: OrderCorrectionRequest,
    ipAddress: string,
  ): Promise<OrderResponse> {
    this.money.ownerOnly(actor, OWNER_ONLY_ACTIONS.reverseBill);

    return this.prisma.$transaction(async (tx) => {
      const order = await this.orders.claimOrder(
        tx,
        actor,
        id,
        request.version,
      );

      if (
        order.status !== OrderStatus.SETTLED ||
        order.channel !== OrderChannel.POS
      ) {
        throw new ConflictException(REVERSE_STAGE_MESSAGE);
      }

      const paidKobo = await this.orders.paidSoFar(tx, id);

      await tx.payment.updateMany({
        where: { orderId: id, reversed: false },
        data: { reversed: true, reversedAt: new Date() },
      });

      if (order.department === Department.BAR) {
        await this.moveBarStock(tx, actor, order, 'reversal');
      }

      if (order.reservationId !== null && order.depositKobo > 0) {
        await tx.$executeRaw`
          UPDATE "Reservation"
             SET "depositUsedKobo" = "depositUsedKobo" - ${order.depositKobo},
                 "updatedAt" = (now() AT TIME ZONE 'UTC')
           WHERE "id" = ${order.reservationId}`;
      }

      await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.PAYMENT,
          settledAt: null,
          depositKobo: 0,
          reservationId: null,
        },
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'order.reverse',
          ref: order.number,
          before: {
            status: order.status,
            paidKobo,
            depositKobo: order.depositKobo,
          },
          after: { status: OrderStatus.PAYMENT, paidKobo: 0, depositKobo: 0 },
          reason: request.reason,
          ipAddress,
        },
        tx,
      );

      return this.orders.readOrder(tx, id);
    });
  }

  /**
   * Write the payments, each with its own `PAY-` number from the sequence
   * (A12), dated today in Lagos: a payment belongs to the day the money was
   * taken (the cash count, C4-8), whatever the bill's own date. Returns the
   * sum recorded.
   */
  private async record(
    tx: Tx,
    actor: StaffPrincipal,
    order: OrderRow,
    payments: readonly TillPayment[],
    flags: { part: boolean },
  ): Promise<number> {
    const businessDate = watToday(new Date());
    let sum = 0;

    for (const payment of payments) {
      await tx.payment.create({
        data: {
          number: await drawNumber(tx, 'payment'),
          orderId: order.id,
          method: payment.method,
          amountKobo: payment.amountKobo,
          sender: payment.sender,
          reference: payment.reference,
          part: flags.part,
          staffId: actor.id,
          businessDate,
        },
        select: { id: true },
      });
      sum += payment.amountKobo;
    }

    return sum;
  }

  /**
   * Take the deposit credit a settlement uses from its booking (D38: the
   * demo's logic, ported for its tests; no route sets a deposit yet). The
   * booking must be checked in or completed at this bill's table, and hold
   * at least that much unused credit. The use is one conditional update,
   * so two bills cannot spend the same credit. Returns the booking's id.
   */
  private async useDepositCredit(
    tx: Tx,
    order: OrderRow,
    request: SettleOrderRequest,
    depositKobo: number,
  ): Promise<string> {
    const booking = request.reservationId
      ? await tx.reservation.findUnique({
          where: { id: request.reservationId },
          select: { id: true, status: true, tableId: true },
        })
      : null;

    if (
      booking === null ||
      (booking.status !== ReservationStatus.CHECKED_IN &&
        booking.status !== ReservationStatus.COMPLETED) ||
      booking.tableId !== order.tableId
    ) {
      throw new BadRequestException(DEPOSIT_RESERVATION_MESSAGE);
    }

    const used = await tx.$executeRaw`
      UPDATE "Reservation"
         SET "depositUsedKobo" = "depositUsedKobo" + ${depositKobo},
             "updatedAt" = (now() AT TIME ZONE 'UTC')
       WHERE "id" = ${booking.id}
         AND "depositKobo" - "depositUsedKobo" >= ${depositKobo}`;

    if (used === 0) throw new ConflictException(DEPOSIT_USED_MESSAGE);

    return booking.id;
  }

  /**
   * A Bar bill's drinks leave the Bar on a settle (`BAR_SALE`) and come
   * back on a reversal (`SETTLEMENT_REVERSAL`), through each drink's paired
   * Bar stock item, with the bill's number as the movement's ref.
   *
   * One movement per stock item: a drink on two lines (two options) moves
   * once by their sum, which the ledger refuses or allows exactly as the
   * demo's line-by-line moves would. The items move in id order, so two
   * settlements sharing drinks take their balance locks in the same order
   * and cannot deadlock each other.
   *
   * A sale first locks the drinks' Bar balances (`lockBalances`, id order)
   * and walks the bill's lines in bill order, so a Bar short of several
   * drinks names the first short one on the bill, as the demo's
   * line-by-line moves do, not the first by id. The ledger's conditional
   * decrement still guards every move.
   */
  private async moveBarStock(
    tx: Tx,
    actor: StaffPrincipal,
    order: OrderRow,
    direction: BarStockDirection,
  ): Promise<void> {
    const lines = await this.orders.lines(tx, order.id);
    const qtyByDish = new Map<string, number>();

    for (const line of lines) {
      qtyByDish.set(
        line.menuItemId,
        (qtyByDish.get(line.menuItemId) ?? 0) + line.qty,
      );
    }

    if (qtyByDish.size === 0) return;

    const paired = await tx.stockItem.findMany({
      where: { menuItemId: { in: [...qtyByDish.keys()] }, kind: StockKind.BAR },
      select: { id: true, name: true, menuItemId: true },
    });

    if (paired.length !== qtyByDish.size) {
      throw new NotFoundException(STOCK_ITEM_NOT_FOUND_MESSAGE);
    }

    if (direction === 'sale') {
      const left = await this.ledger.lockBalances(
        tx,
        paired.map((item) => item.id),
        StockLocation.BAR,
      );
      const byDish = new Map(paired.map((item) => [item.menuItemId, item]));

      for (const line of lines) {
        const item = byDish.get(line.menuItemId);
        if (item === undefined) continue;

        const qty = left.get(item.id) ?? 0;

        if (qty < line.qty) {
          throw new ConflictException(
            insufficientStockMessage(StockLocation.BAR, item.name),
          );
        }

        left.set(item.id, qty - line.qty);
      }
    }

    const moves = paired
      .map((item) => ({
        stockItemId: item.id,
        qty: qtyByDish.get(item.menuItemId ?? '') ?? 0,
      }))
      .sort((a, b) => (a.stockItemId < b.stockItemId ? -1 : 1));

    for (const move of moves) {
      await this.ledger.move(tx, {
        stockItemId: move.stockItemId,
        location: StockLocation.BAR,
        qty: direction === 'sale' ? -move.qty : move.qty,
        type:
          direction === 'sale'
            ? StockMovementType.BAR_SALE
            : StockMovementType.SETTLEMENT_REVERSAL,
        ref: order.number,
        staffId: actor.id,
      });
    }
  }
}
