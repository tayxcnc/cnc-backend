import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CheckoutStatus,
  Department,
  OnlineFulfilmentStatus,
  OnlineOrderMode,
  OnlineRefundStatus,
  OrderChannel,
  OrderStatus,
  PaymentMethod,
  Prisma,
  StockKind,
  StockLocation,
  StockMovementType,
} from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import {
  deliveryAddressText,
  toDeliveryAddress,
  type DeliveryAddress,
} from '../common/delivery-address';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { watToday } from '../common/wat';
import { customerPhone } from '../customers/profile-rules';
import {
  LIMITED_DECISIONS,
  MoneyControlService,
} from '../money-control/money-control.service';
import { checkoutAddressProblem } from '../ordering/dto/checkout.dto';
import { sameDocketItems } from '../orders/docket-items';
import { DocketsService } from '../orders/dockets.service';
import type { DocketResponse } from '../orders/dto/order.response';
import { MAX_LINE_QTY, QTY_MAX_MESSAGE } from '../orders/order-messages';
import { orderTotals } from '../orders/order-totals';
import { OrdersService } from '../orders/orders.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import { drawNumber } from '../prisma/sequences';
import { PushQueueService } from '../push/push-queue.service';
import { StockLedgerService } from '../stock/stock-ledger.service';
import {
  type HeldCheckoutResolveRequest,
  OnlineBalanceMethod,
  type OnlineBalanceRequest,
  OnlineRefundOutcome,
  type OnlineRefundResolveRequest,
  type OnlineCancelRequest,
  type OnlineCorrectStatusRequest,
  type OnlineEditRequest,
  type OnlineOrderListQuery,
  OnlineOrderTab,
  type OnlineStatusRequest,
  type OnlineZoneRequest,
} from './dto/online-order.request';
import type {
  OnlineMoneyResponse,
  OnlineOrderChangeResponse,
  OnlineOrderPageResponse,
  OnlineOrderResponse,
  OnlineOrderSummaryResponse,
} from './dto/online-order.response';
import {
  BALANCE_TRANSFER_MESSAGE,
  CARD_REFUND_LIMIT_MESSAGE,
  CHECKOUT_NOT_HELD_MESSAGE,
  DELIVERY_ADDRESS_MESSAGE,
  EXTRA_MONEY_METHOD_MESSAGE,
  HELD_CHECKOUT_NOT_FOUND_MESSAGE,
  NO_ADJUSTMENT_MESSAGE,
  ONLINE_ORDER_CLOSED_MESSAGE,
  ONLINE_ORDER_NOT_FOUND_MESSAGE,
  OUTSTANDING_BALANCE_MESSAGE,
  REFUND_ID_MESSAGE,
  REFUND_NOT_FOUND_MESSAGE,
  REFUND_NOT_UNCONFIRMED_MESSAGE,
  SELECT_ACTIVE_ONLINE_ORDER_MESSAGE,
  SELECT_ONLINE_ORDER_MESSAGE,
  ZONE_BEFORE_DISPATCH_MESSAGE,
} from './online-order-messages';
import { OnlineOrderMail } from './online-order-mail';
import {
  OnlineRefundsService,
  REFUND_SENDING_STUCK_MS,
} from './online-refunds.service';
import { queueWebDocketPush } from './web-docket-push';
import {
  ACTIVE_ONLINE_STATUSES,
  barDifference,
  type BarLine,
  correctStatusProblem,
  editLineProblem,
  heldToTaken,
  isClosed,
  isCompleted,
  modeFulfilment,
  modeZone,
  nextStageProblem,
  onlineTargetKobo,
  recordedBalanceKobo,
  webDocketDate,
  webDocketItems,
  zoneFeeKobo,
} from './online-order-rules';

type Tx = Prisma.TransactionClient;

/** Either the base client or a command's transaction. */
type Reader = Tx | CncPrismaService;

/** The online order and its bill, as a command holds them locked. */
interface Claimed {
  online: Prisma.OnlineOrderGetPayload<object>;
  order: Prisma.OrderGetPayload<object>;
}

/** One line of a bill, as the commands read it. */
interface Line {
  id: string;
  menuItemId: string;
  name: string;
  option: string;
  qty: number;
  unitPriceKobo: number;
  department: Department;
}

/** A line a manager's edit asks for, priced and named. */
interface WantedLine {
  menuItemId: string;
  name: string;
  option: string;
  qty: number;
  unitPriceKobo: number;
  department: Department;
}

/** What the history shows of a bill's lines (as `order.quantity` does). */
function auditItems(lines: readonly Omit<Line, 'id'>[]) {
  return lines.map((line) => ({
    name: line.name,
    option: line.option,
    qty: line.qty,
    unitPriceKobo: line.unitPriceKobo,
  }));
}

/** The stages a delivery's zone and address may still change in. */
const BEFORE_DISPATCH: OnlineFulfilmentStatus[] = [
  OnlineFulfilmentStatus.RECEIVED,
  OnlineFulfilmentStatus.PREPARING,
];

/** What `balance` hands its controller: the order, and a refund to send. */
export interface BalanceRecorded {
  onlineOrder: OnlineOrderResponse;
  /** The card refund to send to Paystack after the commit, if any. */
  refundId: string | null;
  /** A Cash or Transfer refund's notice to send after the commit (C7-6). */
  noticeKey: string | null;
}

/**
 * Online Orders for staff (plan §5.4, §6.2, §7.4 steps 6 and 7; card
 * C7-4): the Cashier's next-stage move, and the managers' corrections,
 * edits, cancellations, zone changes and money settlements, with the
 * reads.
 *
 * Every command is one transaction that claims the online order's
 * `version` first (A8), which locks it, then locks its bill (`FOR
 * UPDATE`), so every online command on one order runs one at a time, and
 * writes its audit row in it with the bill's number as the ref (the demo's
 * `ref = w.orderRef`). `online.balance` runs in the idempotency service's
 * transaction (A9).
 *
 * **The money.** A paid web order is worth its bill's total plus its
 * delivery fee, nothing once cancelled (the demo's `target`); what was
 * paid is the bill's payments, reversed ones excluded, refunds negative.
 * A manager's edit, cancellation or zone change is checked against the
 * limits on the difference it makes and counted toward the day (L, D),
 * and leaves an `OnlineAdjustment`; `online.balance` records the money
 * that settles them (also L, D, as the demo counts both). An order
 * completes only once nothing is owed either way.
 *
 * **The Bar.** An edit moves the drinks' Bar stock by the difference and
 * a cancellation returns them (D30), through the stock ledger with
 * `allowNegative`, as the paid order took them: the money is already
 * taken, so stock never blocks a correction of it.
 */
@Injectable()
export class OnlineOrdersService {
  private readonly logger = new Logger(OnlineOrdersService.name);

  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
    private readonly orders: OrdersService,
    private readonly dockets: DocketsService,
    private readonly money: MoneyControlService,
    private readonly ledger: StockLedgerService,
    private readonly mail: OnlineOrderMail,
    private readonly refunds: OnlineRefundsService,
    private readonly push: PushQueueService,
  ) {}

  /** Send a queued customer email after the commit (C7-6). Never throws. */
  async dispatchMail(dedupeKey: string | null): Promise<void> {
    await this.mail.dispatch(dedupeKey);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** `GET /staff/online-orders?tab`: newest first, as the demo lists them. */
  async list(query: OnlineOrderListQuery): Promise<OnlineOrderPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const tab = query.tab ?? OnlineOrderTab.ACTIVE;
    const contains = (text: string) => ({
      contains: text,
      mode: Prisma.QueryMode.insensitive,
    });
    const where: Prisma.OnlineOrderWhereInput = {
      fulfilmentStatus:
        tab === OnlineOrderTab.ACTIVE
          ? { in: ACTIVE_ONLINE_STATUSES }
          : { notIn: ACTIVE_ONLINE_STATUSES },
      ...(query.q
        ? {
            OR: [
              { number: contains(query.q) },
              { order: { number: contains(query.q) } },
              { contactName: contains(query.q) },
              { contactPhone: contains(query.q.replace(/[\s-]/g, '')) },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.onlineOrder.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const total = await this.prisma.onlineOrder.count({ where });
    const orderIds = rows.map((row) => row.orderId);
    const bills = await this.prisma.order.findMany({
      where: { id: { in: orderIds } },
    });
    const lines = await this.prisma.orderLine.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true, qty: true, unitPriceKobo: true },
    });
    const paid = await this.prisma.payment.groupBy({
      by: ['orderId'],
      where: { orderId: { in: orderIds }, reversed: false },
      _sum: { amountKobo: true },
    });
    const billOf = new Map(bills.map((bill) => [bill.id, bill]));
    const paidOf = new Map(
      paid.map((sum) => [sum.orderId, sum._sum.amountKobo ?? 0]),
    );

    return {
      data: rows.map((row) => {
        const bill = billOf.get(row.orderId)!;
        const totalKobo = onlineTargetKobo({
          cancelled: bill.status === OrderStatus.CANCELLED,
          billTotalKobo: orderTotals({
            ...bill,
            lines: lines.filter((line) => line.orderId === bill.id),
          }).totalKobo,
          feeKobo: row.feeKobo,
        });
        const paidKobo = paidOf.get(row.orderId) ?? 0;

        return summary(row, bill.number, {
          totalKobo,
          paidKobo,
          balanceKobo: totalKobo - paidKobo,
        });
      }),
      page,
      pageSize,
      total,
    };
  }

  /** `GET /staff/online-orders/:id`. */
  async detail(id: string): Promise<OnlineOrderResponse> {
    const found = await this.prisma.onlineOrder.findUnique({
      where: { id },
      select: { id: true },
    });

    if (found === null) {
      throw new NotFoundException(ONLINE_ORDER_NOT_FOUND_MESSAGE);
    }

    return this.read(this.prisma, id);
  }

  /**
   * One online order as every route answers it. Each relation is its own
   * query, awaited in turn, so it is safe on a transaction's one
   * connection (*Data and migrations*).
   */
  async read(client: Reader, id: string): Promise<OnlineOrderResponse> {
    const online = await client.onlineOrder.findUniqueOrThrow({
      where: { id },
    });
    const bill = await this.orders.readOrder(client, online.orderId);
    const money = await this.moneyOf(client, online, bill.status);
    const adjustments = await client.onlineAdjustment.findMany({
      where: { onlineOrderId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const refunds = await client.onlineRefund.findMany({
      where: { onlineOrderId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const staff = await client.staff.findMany({
      where: {
        id: {
          in: [
            ...adjustments.map((one) => one.staffId),
            ...refunds.map((one) => one.staffId),
          ],
        },
      },
      select: { id: true, name: true },
    });
    const nameOf = new Map(staff.map((one) => [one.id, one.name]));
    const paymentNumber = new Map(
      bill.payments.map((payment) => [payment.id, payment.number]),
    );

    return {
      ...summary(online, bill.number, money),
      paystackReference: online.paystackReference,
      contactEmail: online.contactEmail,
      address:
        online.mode === OnlineOrderMode.PICKUP || online.addressStreet === null
          ? null
          : {
              street: online.addressStreet,
              area: online.addressArea ?? '',
              town: online.addressTown ?? '',
              landmark: online.addressLandmark ?? '',
            },
      note: online.note,
      zoneFees: {
        deliveryJosKobo: online.deliveryJosKobo,
        deliveryOutsideKobo: online.deliveryOutsideKobo,
      },
      money,
      order: bill,
      adjustments: adjustments.map((one) => ({
        id: one.id,
        action: one.action,
        amountKobo: one.amountKobo,
        reason: one.reason,
        staffName: nameOf.get(one.staffId) ?? '',
        settled: one.settledAt !== null,
        settledAt: one.settledAt?.toISOString() ?? null,
        settledPaymentNumber: one.settledPaymentId
          ? (paymentNumber.get(one.settledPaymentId) ?? null)
          : null,
        createdAt: one.createdAt.toISOString(),
      })),
      refunds: refunds.map((one) => ({
        id: one.id,
        paymentNumber: paymentNumber.get(one.paymentId) ?? '',
        amountKobo: one.amountKobo,
        status: one.status,
        providerRefundId: one.providerRefundId,
        providerMessage: one.providerMessage,
        staffName: nameOf.get(one.staffId) ?? '',
        createdAt: one.createdAt.toISOString(),
        sentAt: one.sentAt?.toISOString() ?? null,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * `online.status` (R(Cashier)): the current stage again or the next one
   * on the order's path, never back or past one (the manager's
   * correction). Completed only once nothing is owed either way.
   */
  async status(
    actor: StaffPrincipal,
    id: string,
    request: OnlineStatusRequest,
    ipAddress: string,
  ): Promise<OnlineOrderResponse> {
    const { result, mailKey } = await this.prisma.$transaction(async (tx) => {
      const { online, order } = await this.claim(tx, id, request.version);

      if (isClosed(online.fulfilmentStatus)) {
        throw new ConflictException(ONLINE_ORDER_CLOSED_MESSAGE);
      }

      const problem = nextStageProblem(
        online.mode,
        online.fulfilmentStatus,
        request.status,
      );

      if (problem !== null) throw new ConflictException(problem);

      if (isCompleted(request.status)) {
        await this.assertNothingOwed(tx, online, order);
      }

      await tx.onlineOrder.update({
        where: { id },
        data: { fulfilmentStatus: request.status },
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'online.status',
          ref: order.number,
          before: { fulfilmentStatus: online.fulfilmentStatus },
          after: { fulfilmentStatus: request.status },
          channel: OrderChannel.WEB,
          ipAddress,
        },
        tx,
      );

      return {
        result: await this.read(tx, id),
        mailKey: await this.mail.statusChanged(tx, id, online.fulfilmentStatus),
      };
    });

    await this.mail.dispatch(mailKey);

    return result;
  }

  /**
   * `online.correctStatus` (M+r): any stage on the order's own path,
   * earlier ones and a completed order's included; not a cancelled order.
   * Completed only once nothing is owed.
   */
  async correctStatus(
    actor: StaffPrincipal,
    id: string,
    request: OnlineCorrectStatusRequest,
    ipAddress: string,
  ): Promise<OnlineOrderResponse> {
    const { result, mailKey } = await this.prisma.$transaction(async (tx) => {
      const { online, order } = await this.claim(tx, id, request.version);

      if (online.fulfilmentStatus === OnlineFulfilmentStatus.CANCELLED) {
        throw new ConflictException(SELECT_ONLINE_ORDER_MESSAGE);
      }

      const problem = correctStatusProblem(online.mode, request.status);

      if (problem !== null) throw new BadRequestException(problem);

      if (isCompleted(request.status)) {
        await this.assertNothingOwed(tx, online, order);
      }

      await tx.onlineOrder.update({
        where: { id },
        data: { fulfilmentStatus: request.status },
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'online.correctStatus',
          ref: order.number,
          before: { fulfilmentStatus: online.fulfilmentStatus },
          after: { fulfilmentStatus: request.status },
          reason: request.reason,
          channel: OrderChannel.WEB,
          ipAddress,
        },
        tx,
      );

      return {
        result: await this.read(tx, id),
        mailKey: await this.mail.statusChanged(tx, id, online.fulfilmentStatus),
      };
    });

    await this.mail.dispatch(mailKey);

    return result;
  }

  /**
   * `online.edit` (M+r; L, D): the order's whole new list of lines,
   * Restaurant and Bar (D30), and the guest's details. A line already on
   * the order keeps the price it was paid at; a new one takes today's.
   * The difference in what the order is worth is checked against the
   * limits and counted, and left as an adjustment for `online.balance`.
   * The Bar moves by the drinks' difference. The kitchen gets a new
   * docket revision when the food or the note changed.
   */
  async edit(
    actor: StaffPrincipal,
    id: string,
    request: OnlineEditRequest,
    ipAddress: string,
  ): Promise<OnlineOrderChangeResponse> {
    const { result, pushTopic } = await this.prisma.$transaction(async (tx) => {
      const { online, order } = await this.claim(tx, id, request.version);

      if (isClosed(online.fulfilmentStatus)) {
        throw new ConflictException(SELECT_ACTIVE_ONLINE_ORDER_MESSAGE);
      }

      const before: Line[] = await this.orders.lines(tx, order.id);
      const wanted = await this.wantedLines(tx, request, before);

      const contactName = request.contactName || online.contactName;
      const contactPhone =
        customerPhone(request.contactPhone) ?? online.contactPhone;
      const note = request.note ?? online.note;

      const oldTarget = this.targetOf(order, before, online.feeKobo);
      const newTarget = this.targetOf(order, wanted, online.feeKobo);
      const differenceKobo = newTarget - oldTarget;

      await this.money.withinLimit(tx, actor, {
        amountKobo: differenceKobo,
        what: LIMITED_DECISIONS.onlineChange,
        count: true,
        action: 'online.edit',
        ref: order.number,
      });

      await this.replaceLines(tx, order.id, before, wanted);
      await this.moveBar(tx, actor, order.number, before, wanted);

      const latest = await this.dockets.latestForOrder(
        tx,
        order.id,
        order.number,
      );
      const food = webDocketItems(wanted);
      const foodChanged = !sameDocketItems(food, latest?.items ?? []);
      const sendsDocket =
        (latest !== null || food.length > 0) &&
        (foodChanged || (note !== order.notes && food.length > 0));
      const docket = sendsDocket
        ? await this.writeDocket(tx, actor, order, online, {
            items: food,
            notes: note,
            mode: online.mode,
          })
        : null;

      await tx.order.update({
        where: { id: order.id },
        data: {
          guest: contactName,
          notes: note,
          ...(docket ? { revision: docket.revision } : {}),
          version: { increment: 1 },
        },
      });
      await tx.onlineOrder.update({
        where: { id },
        data: { contactName, contactPhone, note },
      });

      await this.adjust(tx, actor, online, order, {
        action: 'online.edit',
        amountKobo: differenceKobo,
        reason: request.reason,
        targetKobo: newTarget,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'online.edit',
          ref: order.number,
          before: {
            items: auditItems(before),
            contactName: online.contactName,
            contactPhone: online.contactPhone,
            note: online.note,
            totalKobo: oldTarget,
          },
          after: {
            items: auditItems(wanted),
            contactName,
            contactPhone,
            note,
            totalKobo: newTarget,
            ...(docket
              ? { docket: docket.ref, revision: docket.revision }
              : {}),
          },
          reason: request.reason,
          channel: OrderChannel.WEB,
          ipAddress,
        },
        tx,
      );

      return {
        result: { onlineOrder: await this.read(tx, id), docket },
        // The kitchen's devices hear of the new revision (C10, PS2).
        pushTopic:
          docket === null
            ? null
            : await queueWebDocketPush(this.push, tx, docket, [actor.id]),
      };
    });

    await this.push.dispatchTopics([pushTopic]);

    return result;
  }

  /**
   * `online.cancel` (M+r; L, D; Q8: managers only, before Completed): the
   * order is worth nothing from now on, so everything paid is owed back
   * (`online.balance` returns it). The drinks go back to the Bar; a
   * kitchen that was sent food gets a cancellation docket (a revision
   * with no items) to print. The lines stay on the bill as its history.
   */
  async cancel(
    actor: StaffPrincipal,
    id: string,
    request: OnlineCancelRequest,
    ipAddress: string,
  ): Promise<OnlineOrderChangeResponse> {
    const { result, mailKey } = await this.prisma.$transaction(async (tx) => {
      const { online, order } = await this.claim(tx, id, request.version);

      if (isClosed(online.fulfilmentStatus)) {
        throw new ConflictException(SELECT_ACTIVE_ONLINE_ORDER_MESSAGE);
      }

      const lines: Line[] = await this.orders.lines(tx, order.id);
      const oldTarget = this.targetOf(order, lines, online.feeKobo);
      const differenceKobo = -oldTarget;

      await this.money.withinLimit(tx, actor, {
        amountKobo: differenceKobo,
        what: LIMITED_DECISIONS.onlineChange,
        count: true,
        action: 'online.cancel',
        ref: order.number,
      });

      await this.moveBar(tx, actor, order.number, lines, []);

      const latest = await this.dockets.latestForOrder(
        tx,
        order.id,
        order.number,
      );
      const docket =
        latest !== null && latest.items.length > 0
          ? await this.writeDocket(tx, actor, order, online, {
              items: [],
              notes: '',
              mode: online.mode,
            })
          : null;

      await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.CANCELLED,
          settledAt: null,
          ...(docket ? { revision: docket.revision } : {}),
          version: { increment: 1 },
        },
      });
      await tx.onlineOrder.update({
        where: { id },
        data: { fulfilmentStatus: OnlineFulfilmentStatus.CANCELLED },
      });

      await this.adjust(tx, actor, online, order, {
        action: 'online.cancel',
        amountKobo: differenceKobo,
        reason: request.reason,
        targetKobo: 0,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'online.cancel',
          ref: order.number,
          before: {
            fulfilmentStatus: online.fulfilmentStatus,
            totalKobo: oldTarget,
          },
          after: {
            fulfilmentStatus: OnlineFulfilmentStatus.CANCELLED,
            totalKobo: 0,
            ...(docket
              ? { docket: docket.ref, revision: docket.revision }
              : {}),
          },
          reason: request.reason,
          channel: OrderChannel.WEB,
          ipAddress,
        },
        tx,
      );

      return {
        result: { onlineOrder: await this.read(tx, id), docket },
        mailKey: await this.mail.statusChanged(tx, id, online.fulfilmentStatus),
      };
    });

    await this.mail.dispatch(mailKey);

    return result;
  }

  /**
   * `online.zone` (M+r; Q27): before dispatch, the delivery mode and
   * address change, and the fee is recomputed from the fees the order
   * snapshotted at checkout. The difference is checked against the limits
   * and counted, and left as an adjustment for `online.balance`. A switch
   * between delivery and pickup reprints the docket with the new
   * fulfilment when the kitchen has food on it.
   */
  async zone(
    actor: StaffPrincipal,
    id: string,
    request: OnlineZoneRequest,
    ipAddress: string,
  ): Promise<OnlineOrderChangeResponse> {
    const { result, pushTopic } = await this.prisma.$transaction(async (tx) => {
      const { online, order } = await this.claim(tx, id, request.version);

      if (!BEFORE_DISPATCH.includes(online.fulfilmentStatus)) {
        throw new ConflictException(ZONE_BEFORE_DISPATCH_MESSAGE);
      }

      const address = this.zoneAddress(online, request);
      const feeKobo = zoneFeeKobo(request.mode, online);
      const differenceKobo = feeKobo - online.feeKobo;
      const lines: Line[] = await this.orders.lines(tx, order.id);

      await this.money.withinLimit(tx, actor, {
        amountKobo: differenceKobo,
        what: LIMITED_DECISIONS.onlineChange,
        count: true,
        action: 'online.zone',
        ref: order.number,
      });

      const addressText =
        address === null
          ? ''
          : deliveryAddressText({
              addressStreet: address.street,
              addressArea: address.area,
              addressTown: address.town,
              addressLandmark: address.landmark,
            });

      await tx.onlineOrder.update({
        where: { id },
        data: {
          mode: request.mode,
          addressStreet: address?.street ?? null,
          addressArea: address?.area ?? null,
          addressTown: address?.town ?? null,
          addressLandmark: address?.landmark ?? null,
          addressText,
          feeKobo,
        },
      });

      const latest = await this.dockets.latestForOrder(
        tx,
        order.id,
        order.number,
      );
      const docket =
        latest !== null &&
        latest.items.length > 0 &&
        modeFulfilment(request.mode) !== modeFulfilment(online.mode)
          ? await this.writeDocket(tx, actor, order, online, {
              items: latest.items,
              notes: order.notes,
              mode: request.mode,
            })
          : null;

      if (docket) {
        await tx.order.update({
          where: { id: order.id },
          data: { revision: docket.revision, version: { increment: 1 } },
        });
      }

      await this.adjust(tx, actor, online, order, {
        action: 'online.zone',
        amountKobo: differenceKobo,
        reason: request.reason,
        targetKobo: this.targetOf(order, lines, feeKobo),
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'online.zone',
          ref: order.number,
          before: {
            mode: online.mode,
            addressText: online.addressText,
            feeKobo: online.feeKobo,
          },
          after: {
            mode: request.mode,
            addressText,
            feeKobo,
            ...(docket
              ? { docket: docket.ref, revision: docket.revision }
              : {}),
          },
          reason: request.reason,
          channel: OrderChannel.WEB,
          ipAddress,
        },
        tx,
      );

      return {
        result: { onlineOrder: await this.read(tx, id), docket },
        // The reprint with the new fulfilment rings the kitchen (PS2).
        pushTopic:
          docket === null
            ? null
            : await queueWebDocketPush(this.push, tx, docket, [actor.id]),
      };
    });

    await this.push.dispatchTopics([pushTopic]);

    return result;
  }

  /**
   * `online.balance` (M+r; L, D; Q26, Q34): records the money that brings
   * the order back to owing nothing, the whole balance in one payment, as
   * the demo does. Extra money due is Cash or Transfer taken by staff
   * (Q34); a refund is Cash or Transfer given back, or a card refund
   * through Paystack (Q26), never more than the card paid and has not had
   * back: a refund owed beyond that sends the card's part and leaves the
   * rest owed, for a Cash or Transfer `online.balance`
   * (`recordedBalanceKobo`). Runs in the idempotency service's transaction
   * (A9).
   *
   * A card refund is recorded here, `PENDING`, as a negative `ONLINE`
   * payment with its `OnlineRefund`; Paystack is asked only after this
   * transaction commits (`OnlineRefundsService.send`), because a network
   * call must not hold a transaction (the pool is 3).
   */
  async balance(
    tx: Tx,
    actor: StaffPrincipal,
    id: string,
    request: OnlineBalanceRequest,
    ipAddress: string,
  ): Promise<BalanceRecorded> {
    // The demo's order: the order (404, or a stale version), something
    // owed, the limits, then the transfer's details. The card's own
    // sentences (new) come before the limits, which judge what is
    // recorded.
    const { online, order } = await this.claim(tx, id, request.version);
    const money = await this.moneyOf(tx, online, order.status);
    const balanceKobo = money.balanceKobo;

    if (balanceKobo === 0) {
      throw new ConflictException(NO_ADJUSTMENT_MESSAGE);
    }

    const toCard = request.method === OnlineBalanceMethod.PAYSTACK;

    if (toCard && balanceKobo > 0) {
      throw new BadRequestException(EXTRA_MONEY_METHOD_MESSAGE);
    }

    if (toCard && money.cardRefundableKobo === 0) {
      throw new ConflictException(CARD_REFUND_LIMIT_MESSAGE);
    }

    const amountKobo = recordedBalanceKobo({
      balanceKobo,
      toCard,
      cardRefundableKobo: money.cardRefundableKobo,
    });

    // A card refund keeps the row that counted it, so a refusal can give
    // back exactly that (C8-0); Cash and Transfer are money already moved.
    const counted = await this.money.withinLimit(tx, actor, {
      amountKobo,
      what: LIMITED_DECISIONS.paymentCorrection,
      count: true,
      action: 'online.balance',
      ref: order.number,
    });

    if (
      request.method === OnlineBalanceMethod.TRANSFER &&
      (!request.sender || !request.reference)
    ) {
      throw new BadRequestException(BALANCE_TRANSFER_MESSAGE);
    }

    const settlesAll = amountKobo === balanceKobo;

    const payment = await tx.payment.create({
      data: {
        number: await drawNumber(tx, 'payment'),
        orderId: order.id,
        method: toCard
          ? PaymentMethod.ONLINE
          : request.method === OnlineBalanceMethod.CASH
            ? PaymentMethod.CASH
            : PaymentMethod.TRANSFER,
        amountKobo,
        sender: toCard ? '' : (request.sender ?? ''),
        reference: toCard
          ? online.paystackReference
          : (request.reference ?? ''),
        staffId: actor.id,
        businessDate: watToday(new Date()),
      },
      select: { id: true, number: true },
    });

    const refund = toCard
      ? await tx.onlineRefund.create({
          data: {
            onlineOrderId: id,
            paymentId: payment.id,
            transactionReference: online.paystackReference,
            amountKobo: -amountKobo,
            staffId: actor.id,
            ledgerEntryId: counted?.id ?? null,
          },
          select: { id: true },
        })
      : null;

    // The adjustments are settled only by the payment that brings the
    // balance to 0; a card refund of part leaves them open for the rest.
    if (settlesAll) {
      await tx.onlineAdjustment.updateMany({
        where: { onlineOrderId: id, settledAt: null },
        data: { settledAt: new Date(), settledPaymentId: payment.id },
      });
    }

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'online.balance',
        ref: order.number,
        before: { paidKobo: money.paidKobo, balanceKobo },
        after: {
          paidKobo: money.paidKobo + amountKobo,
          balanceKobo: balanceKobo - amountKobo,
          method: request.method,
          payment: payment.number,
          ...(refund ? { refund: OnlineRefundStatus.PENDING } : {}),
        },
        reason: request.reason,
        channel: OrderChannel.WEB,
        ipAddress,
      },
      tx,
    );

    // C7-6: money handed back by Cash or Transfer is given now, so the
    // customer is told now; a card refund is told once Paystack accepts it
    // (`OnlineRefundsService.send`). Extra money taken sends nothing: the
    // customer paid it in person.
    const noticeKey =
      balanceKobo < 0 && !toCard
        ? await this.mail.refunded(tx, id, {
            paymentId: payment.id,
            amountKobo: -balanceKobo,
            method:
              request.method === OnlineBalanceMethod.CASH ? 'CASH' : 'TRANSFER',
          })
        : null;

    return {
      onlineOrder: await this.read(tx, id),
      refundId: refund?.id ?? null,
      noticeKey,
    };
  }

  /**
   * A manager records what Paystack's dashboard shows for a card refund
   * whose answer never arrived (`UNCONFIRMED`), or one stuck `SENDING`
   * past `REFUND_SENDING_STUCK_MS` (M+r, new). Shown: `SENT` with the
   * dashboard's refund id, and the customer is told. Not shown: undone as
   * a refusal is, so the refund is owed again for a Cash or Transfer
   * `online.balance`. Claims the order's version like every online
   * command, so it cannot race a balance; audited `online.resolveRefund`.
   * Answers the order and the notice to send after the commit.
   */
  async resolveRefund(
    actor: StaffPrincipal,
    id: string,
    refundId: string,
    request: OnlineRefundResolveRequest,
    ipAddress: string,
  ): Promise<{ onlineOrder: OnlineOrderResponse; noticeKey: string | null }> {
    const shown = request.outcome === OnlineRefundOutcome.SENT;

    if (shown && !request.providerRefundId) {
      throw new BadRequestException(REFUND_ID_MESSAGE);
    }

    return this.prisma.$transaction(async (tx) => {
      const { order } = await this.claim(tx, id, request.version);
      const refund = await tx.onlineRefund.findFirst({
        where: { id: refundId, onlineOrderId: id },
      });

      if (refund === null) {
        throw new NotFoundException(REFUND_NOT_FOUND_MESSAGE);
      }

      const stuck =
        refund.status === OnlineRefundStatus.SENDING &&
        refund.updatedAt.getTime() <= Date.now() - REFUND_SENDING_STUCK_MS;

      if (refund.status !== OnlineRefundStatus.UNCONFIRMED && !stuck) {
        throw new ConflictException(REFUND_NOT_UNCONFIRMED_MESSAGE);
      }

      const noticeKey = await this.refunds.resolve(
        tx,
        refund,
        shown ? { providerRefundId: request.providerRefundId! } : null,
      );

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'online.resolveRefund',
          ref: order.number,
          before: { status: refund.status, amountKobo: refund.amountKobo },
          after: {
            status: shown
              ? OnlineRefundStatus.SENT
              : OnlineRefundStatus.REFUSED,
            ...(shown ? { providerRefundId: request.providerRefundId } : {}),
          },
          reason: request.reason,
          channel: OrderChannel.WEB,
          ipAddress,
        },
        tx,
      );

      return { onlineOrder: await this.read(tx, id), noticeKey };
    });
  }

  /**
   * A manager closes a checkout held `NEEDS_ATTENTION` once the money is
   * sorted out in Paystack's dashboard (M+r, new): `RESOLVED`, final, so
   * it leaves the managers' bell and no longer blocks its customer's
   * account deletion. One conditional update on `NEEDS_ATTENTION`, so two
   * managers resolving it at once resolve it once; audited
   * `online.resolveCheckout` under the checkout's reference.
   */
  async resolveCheckout(
    actor: StaffPrincipal,
    checkoutId: string,
    request: HeldCheckoutResolveRequest,
    ipAddress: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.checkout.updateMany({
        where: { id: checkoutId, status: CheckoutStatus.NEEDS_ATTENTION },
        data: { status: CheckoutStatus.RESOLVED, resolvedAt: new Date() },
      });
      const checkout = await tx.checkout.findUnique({
        where: { id: checkoutId },
        select: {
          reference: true,
          totalKobo: true,
          attentionReason: true,
        },
      });

      if (checkout === null) {
        throw new NotFoundException(HELD_CHECKOUT_NOT_FOUND_MESSAGE);
      }

      if (count === 0) throw new ConflictException(CHECKOUT_NOT_HELD_MESSAGE);

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'online.resolveCheckout',
          ref: checkout.reference,
          before: {
            status: CheckoutStatus.NEEDS_ATTENTION,
            totalKobo: checkout.totalKobo,
            attentionReason: checkout.attentionReason,
          },
          after: { status: CheckoutStatus.RESOLVED },
          reason: request.reason,
          channel: OrderChannel.WEB,
          ipAddress,
        },
        tx,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Shared steps
  // -------------------------------------------------------------------------

  /**
   * The demo's `online.find`: the order exists (404), its `version` is
   * claimed (which locks it, A8), then its bill is locked too, so the
   * command runs on rows nobody else can change.
   */
  private async claim(tx: Tx, id: string, version: number): Promise<Claimed> {
    const found = await tx.onlineOrder.findUnique({
      where: { id },
      select: { id: true },
    });

    if (found === null) {
      throw new NotFoundException(ONLINE_ORDER_NOT_FOUND_MESSAGE);
    }

    await claimVersion(tx, {
      table: 'OnlineOrder',
      id,
      version,
      notFound: ONLINE_ORDER_NOT_FOUND_MESSAGE,
    });

    const online = await tx.onlineOrder.findUniqueOrThrow({ where: { id } });

    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${online.orderId} FOR UPDATE`;

    const order = await tx.order.findUniqueOrThrow({
      where: { id: online.orderId },
    });

    return { online, order };
  }

  /** What the order is worth with these lines and this fee (`target`). */
  private targetOf(
    order: Claimed['order'],
    lines: readonly { qty: number; unitPriceKobo: number }[],
    feeKobo: number,
  ): number {
    return onlineTargetKobo({
      cancelled: order.status === OrderStatus.CANCELLED,
      billTotalKobo: orderTotals({ ...order, lines }).totalKobo,
      feeKobo,
    });
  }

  /** The money of an order as it stands, for the reads and the balance. */
  private async moneyOf(
    client: Reader,
    online: { orderId: string; feeKobo: number },
    status: OrderStatus,
  ): Promise<OnlineMoneyResponse> {
    const order = await client.order.findUniqueOrThrow({
      where: { id: online.orderId },
    });
    const lines = await this.orders.lines(client, online.orderId);
    const billTotalKobo = orderTotals({ ...order, lines }).totalKobo;
    const totalKobo = onlineTargetKobo({
      cancelled: status === OrderStatus.CANCELLED,
      billTotalKobo,
      feeKobo: online.feeKobo,
    });
    const paidKobo = await this.orders.paidSoFar(client, online.orderId);
    const card = await client.payment.aggregate({
      where: {
        orderId: online.orderId,
        method: PaymentMethod.ONLINE,
        reversed: false,
      },
      _sum: { amountKobo: true },
    });

    return {
      billTotalKobo,
      feeKobo: online.feeKobo,
      totalKobo,
      paidKobo,
      balanceKobo: totalKobo - paidKobo,
      cardRefundableKobo: Math.max(0, card._sum.amountKobo ?? 0),
    };
  }

  /** The demo's completion rule: paid exactly what the order is worth. */
  private async assertNothingOwed(
    tx: Tx,
    online: Claimed['online'],
    order: Claimed['order'],
  ): Promise<void> {
    const money = await this.moneyOf(tx, online, order.status);

    if (money.balanceKobo !== 0) {
      throw new ConflictException(OUTSTANDING_BALANCE_MESSAGE);
    }
  }

  /**
   * The edit's lines, judged in the demo's order (each line's dish, then
   * its choice) and priced: a dish already on the order keeps the name
   * and price it was paid at, a new one takes today's (plan §4.1).
   */
  private async wantedLines(
    tx: Tx,
    request: OnlineEditRequest,
    before: readonly Line[],
  ): Promise<WantedLine[]> {
    const items = await tx.menuItem.findMany({
      where: {
        id: { in: request.lines.map((line) => String(line.menuItemId)) },
      },
      select: {
        id: true,
        name: true,
        priceKobo: true,
        department: true,
        active: true,
        choiceLabel: true,
        choiceOptions: true,
      },
    });
    const itemOf = new Map(items.map((item) => [item.id, item]));

    return request.lines.map((line) => {
      const option = typeof line.option === 'string' ? line.option : '';
      const item = itemOf.get(line.menuItemId) ?? null;
      // A line is its dish and option (the bill's own key): only a line
      // the order already holds keeps what it was paid at; another option
      // of the same dish is a new line at today's price (plan §4.1).
      const held = before.find(
        (one) => one.menuItemId === line.menuItemId && one.option === option,
      );
      const problem = editLineProblem(item, option, held !== undefined);

      if (problem !== null || item === null) {
        throw new BadRequestException(problem);
      }

      if (line.qty > MAX_LINE_QTY) {
        throw new BadRequestException(QTY_MAX_MESSAGE);
      }

      return {
        menuItemId: item.id,
        name: held?.name ?? item.name,
        option,
        qty: line.qty,
        unitPriceKobo: held?.unitPriceKobo ?? item.priceKobo,
        department: item.department,
      };
    });
  }

  /**
   * The bill's lines become `wanted`: a line kept changes its quantity in
   * place (its id and position stay), a line gone is removed, a new one is
   * added.
   */
  private async replaceLines(
    tx: Tx,
    orderId: string,
    before: readonly Line[],
    wanted: readonly WantedLine[],
  ): Promise<void> {
    const same = (a: { menuItemId: string; option: string }, b: typeof a) =>
      a.menuItemId === b.menuItemId && a.option === b.option;

    for (const line of before) {
      const kept = wanted.find((one) => same(one, line));

      if (kept === undefined) {
        await tx.orderLine.delete({ where: { id: line.id } });
      } else if (kept.qty !== line.qty) {
        await tx.orderLine.update({
          where: { id: line.id },
          data: { qty: kept.qty },
        });
      }
    }

    for (const line of wanted) {
      if (before.some((one) => same(one, line))) continue;

      await tx.orderLine.create({ data: { orderId, ...line } });
    }
  }

  /**
   * The drinks move by the difference between two sets of lines (D30): more
   * served leave the Bar (`WEB_SALE`), fewer come back (`WEB_SALE_RETURN`),
   * one movement per paired stock item in id order, with `allowNegative`
   * as the paid order's own sale. A drink with no paired item moves
   * nothing and is logged, as at payment. A return is never more than the
   * order's own movements took from that item (`heldToTaken`), and a
   * cancellation returns exactly what they took, so a pairing changed
   * since the sale cannot put back stock that never left.
   */
  private async moveBar(
    tx: Tx,
    actor: StaffPrincipal,
    orderNumber: string,
    before: readonly BarLine[],
    after: readonly BarLine[],
  ): Promise<void> {
    const drinkIds = [
      ...new Set(
        [...before, ...after]
          .filter((line) => line.department === Department.BAR)
          .map((line) => line.menuItemId),
      ),
    ];

    if (drinkIds.length === 0) return;

    // What the order has taken from each Bar stock item so far, by its own
    // movements: the pairing may have changed since the sale.
    const movements = await tx.stockMovement.groupBy({
      by: ['stockItemId'],
      where: {
        ref: orderNumber,
        location: StockLocation.BAR,
        type: {
          in: [StockMovementType.WEB_SALE, StockMovementType.WEB_SALE_RETURN],
        },
      },
      _sum: { qty: true },
    });
    const taken = new Map(
      movements.map((row) => [row.stockItemId, -(row._sum.qty ?? 0)]),
    );

    let moves: { stockItemId: string; delta: number }[];

    if (after.length === 0) {
      // A cancellation returns exactly what the order took, whatever is
      // paired with which drink today.
      moves = [...taken.entries()]
        .filter(([, qty]) => qty > 0)
        .map(([stockItemId, qty]) => ({ stockItemId, delta: qty }))
        .sort((a, b) => (a.stockItemId < b.stockItemId ? -1 : 1));
    } else {
      const paired = await tx.stockItem.findMany({
        where: { menuItemId: { in: drinkIds }, kind: StockKind.BAR },
        select: { id: true, menuItemId: true },
      });
      const plan = barDifference(
        before,
        after,
        new Map(
          paired.flatMap((item) =>
            item.menuItemId === null ? [] : [[item.menuItemId, item.id]],
          ),
        ),
      );

      if (plan.unpaired.length > 0) {
        this.logger.error(
          `Web order ${orderNumber} changed drinks with no paired Bar stock ` +
            `item, so no stock moved for them: ${plan.unpaired.join(', ')}.`,
        );
      }

      const held = heldToTaken(plan.moves, taken);

      if (held.cut.length > 0) {
        this.logger.warn(
          `Web order ${orderNumber}: a return was held to what the order ` +
            `took from the Bar (stock items ${held.cut.join(', ')}).`,
        );
      }

      moves = held.moves;
    }

    for (const move of moves) {
      await this.ledger.move(tx, {
        stockItemId: move.stockItemId,
        location: StockLocation.BAR,
        qty: move.delta,
        type:
          move.delta < 0
            ? StockMovementType.WEB_SALE
            : StockMovementType.WEB_SALE_RETURN,
        ref: orderNumber,
        staffId: actor.id,
        allowNegative: true,
      });
    }
  }

  /** The next docket revision of a web order, marked web for printing. */
  private writeDocket(
    tx: Tx,
    actor: StaffPrincipal,
    order: Claimed['order'],
    online: Claimed['online'],
    docket: {
      items: Parameters<DocketsService['write']>[1]['items'];
      notes: string;
      mode: OnlineOrderMode;
    },
  ): Promise<DocketResponse> {
    return this.dockets.write(tx, {
      orderId: order.id,
      orderNumber: order.number,
      revision: order.revision + 1,
      businessDate: webDocketDate(online.scheduledFor, order.businessDate),
      items: docket.items,
      notes: docket.notes,
      staffId: actor.id,
      channel: OrderChannel.WEB,
      fulfilment: modeFulfilment(docket.mode),
      scheduledFor: online.scheduledFor,
    });
  }

  /**
   * A change's adjustment: left open for `online.balance` when it moved
   * the order's worth; and when the change leaves nothing owed either way
   * (an edit undoing an earlier one), every open adjustment is settled
   * with no payment, so the order can complete.
   */
  private async adjust(
    tx: Tx,
    actor: StaffPrincipal,
    online: Claimed['online'],
    order: Claimed['order'],
    change: {
      action: 'online.edit' | 'online.cancel' | 'online.zone';
      amountKobo: number;
      reason: string;
      targetKobo: number;
    },
  ): Promise<void> {
    if (change.amountKobo !== 0) {
      await tx.onlineAdjustment.create({
        data: {
          onlineOrderId: online.id,
          action: change.action,
          amountKobo: change.amountKobo,
          reason: change.reason,
          staffId: actor.id,
        },
      });
    }

    const paidKobo = await this.orders.paidSoFar(tx, order.id);

    if (change.targetKobo === paidKobo) {
      await tx.onlineAdjustment.updateMany({
        where: { onlineOrderId: online.id, settledAt: null },
        data: { settledAt: new Date() },
      });
    }
  }

  /**
   * The address a zone change leaves the order with: none for pickup; for
   * a delivery, the one sent, else the one the order holds, judged with
   * the website checkout's sentences for the mode's zone.
   */
  private zoneAddress(
    online: Claimed['online'],
    request: OnlineZoneRequest,
  ): DeliveryAddress | null {
    const zone = modeZone(request.mode);

    if (zone === null) return null;

    const held =
      online.addressStreet === null
        ? undefined
        : {
            street: online.addressStreet,
            area: online.addressArea,
            town: online.addressTown,
            landmark: online.addressLandmark,
          };
    const sent = request.address ?? held;

    if (sent === undefined) {
      throw new BadRequestException(DELIVERY_ADDRESS_MESSAGE);
    }

    const value = { ...sent, zone };
    const problem = checkoutAddressProblem(value);

    if (problem !== null) throw new BadRequestException(problem);

    return toDeliveryAddress(value);
  }
}

/** A row of the list, and the head of the detail. */
function summary(
  online: Prisma.OnlineOrderGetPayload<object>,
  orderNumber: string,
  money: { totalKobo: number; paidKobo: number; balanceKobo: number },
): OnlineOrderSummaryResponse {
  return {
    id: online.id,
    number: online.number,
    orderId: online.orderId,
    orderNumber,
    contactName: online.contactName,
    contactPhone: online.contactPhone,
    mode: online.mode,
    addressText: online.addressText,
    fulfilmentStatus: online.fulfilmentStatus,
    timingText: online.timingText,
    scheduledFor: online.scheduledFor?.toISOString() ?? null,
    totalKobo: money.totalKobo,
    paidKobo: money.paidKobo,
    balanceKobo: money.balanceKobo,
    createdAt: online.createdAt.toISOString(),
    version: online.version,
  };
}
