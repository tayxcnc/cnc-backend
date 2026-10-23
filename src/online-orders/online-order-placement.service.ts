import { Injectable, Logger } from '@nestjs/common';
import {
  type Checkout,
  Department,
  Fulfilment,
  OnlineFulfilmentStatus,
  OrderChannel,
  OrderStatus,
  PaymentMethod,
  type Prisma,
  StockKind,
  StockLocation,
  StockMovementType,
} from '../../generated/cnc-client';
import { AuditService } from '../audit/audit.service';
import { formatIsoDate } from '../common/calendar-date';
import { deliveryAddressText } from '../common/delivery-address';
import { watToday } from '../common/wat';
import { CustomerService } from '../customers/customer.service';
import { parseCheckoutLines } from '../ordering/cart-pricing';
import { DocketsService } from '../orders/dockets.service';
import { drawNumber } from '../prisma/sequences';
import { verifiedCustomerId } from '../reception/customer-link';
import { StockLedgerService } from '../stock/stock-ledger.service';
import { OnlineOrderMail } from './online-order-mail';
import {
  onlineOrderMode,
  webDocketItems,
  webSalePlan,
} from './online-order-rules';

type Tx = Prisma.TransactionClient;

/** The audit actor of a web order: nobody on the staff wrote it. */
export const ONLINE_CHECKOUT_ACTOR = 'Online checkout';

/** What Paystack's verify said about the card, for the payment row. */
export interface PaidWith {
  cardBrand: string | null;
  cardLast4: string | null;
}

/** The numbers a paid web order was given. */
export interface PlacedOnlineOrder {
  orderId: string;
  /** The customer the order was linked to, which the checkout takes too. */
  customerId: string | null;
  orderNumber: string;
  onlineNumber: string;
  paymentNumber: string;
  docketRef: string | null;
  /** The receipt email's dedupe key, to send after the commit (C7-6). */
  receiptKey: string;
}

/**
 * A paid web order, written (plan §7.4 step 4; card C7-3). Called only
 * inside the transaction in which `CheckoutPaymentsService` holds the
 * checkout's row lock and has seen it still settleable, and which then
 * marks it `PAID` with the order's id, so it runs once per checkout
 * whoever reported the payment first (the webhook, the confirmation
 * read's verify or a sweep): a second report waits on the lock, then
 * finds the checkout paid and never gets here. In that transaction, with
 * the audit row:
 *
 * - the customer: the signed-in one who placed it, else a live verified
 *   customer holding the checkout's email or phone (as a guest booking is
 *   linked, Q35), else, when "Save my details" was ticked, the customer
 *   found or made by the email (unverified; no session, A15);
 * - the numbers, drawn only now (`CNCR-`, `WEB-`, `PAY-`), so an abandoned
 *   checkout burns none;
 * - the `Order`, channel `WEB` (POS history tags it Online), `SETTLED`,
 *   with the checkout's lines at the prices paid, each with its own
 *   department (D30), and the checkout's VAT rate; no service charge;
 * - docket revision 1 of the **Restaurant lines only**, marked web with
 *   the fulfilment and scheduled time; none for drinks alone;
 * - the `ONLINE` payment of the checkout's whole total (delivery
 *   included), with the reference, card brand and last four;
 * - the `OnlineOrder`, `RECEIVED`, with the delivery fee as its own line
 *   (Q21);
 * - the Bar movements (`WEB_SALE`) for the drinks through the stock
 *   ledger **with `allowNegative`** (§7.4): the money is taken, so stock
 *   never refuses a paid order; a shortfall shows in Low Stock;
 * - the receipt email (always, Q31) and the customer's in-app item
 *   (`OnlineOrderMail.receipt`, C7-6), sent by the caller after the commit.
 */
@Injectable()
export class OnlineOrderPlacementService {
  private readonly logger = new Logger(OnlineOrderPlacementService.name);

  constructor(
    private readonly audit: AuditService,
    private readonly dockets: DocketsService,
    private readonly ledger: StockLedgerService,
    private readonly customers: CustomerService,
    private readonly mail: OnlineOrderMail,
  ) {}

  async place(
    tx: Tx,
    checkoutId: string,
    paidWith: PaidWith,
  ): Promise<PlacedOnlineOrder> {
    const checkout = await tx.checkout.findUniqueOrThrow({
      where: { id: checkoutId },
    });
    const lines = parseCheckoutLines(checkout.lines);
    const now = new Date();
    const businessDate = watToday(now);
    const customerId = await this.customerFor(tx, checkout);

    const orderNumber = await drawNumber(tx, 'orderRestaurant');
    const onlineNumber = await drawNumber(tx, 'onlineOrder');
    const paymentNumber = await drawNumber(tx, 'payment');

    const food = webDocketItems(lines);

    const order = await tx.order.create({
      data: {
        number: orderNumber,
        department: Department.RESTAURANT,
        channel: OrderChannel.WEB,
        label: onlineNumber,
        guest: checkout.contactName,
        businessDate,
        status: OrderStatus.SETTLED,
        revision: food.length > 0 ? 1 : 0,
        vatBps: checkout.vatBps,
        serviceBps: 0,
        notes: checkout.note,
        settledAt: now,
        openedById: null,
        customerId,
      },
      select: { id: true },
    });

    await tx.orderLine.createMany({
      data: lines.map((line) => ({
        orderId: order.id,
        menuItemId: line.menuItemId,
        name: line.name,
        option: line.option,
        qty: line.qty,
        unitPriceKobo: line.unitPriceKobo,
        department: line.department,
      })),
    });

    const docket =
      food.length === 0
        ? null
        : await this.dockets.write(tx, {
            orderId: order.id,
            orderNumber,
            revision: 1,
            businessDate,
            items: food,
            notes: checkout.note,
            staffId: null,
            channel: OrderChannel.WEB,
            fulfilment: checkout.fulfilment,
            scheduledFor: checkout.scheduledFor,
          });

    await tx.payment.create({
      data: {
        number: paymentNumber,
        orderId: order.id,
        method: PaymentMethod.ONLINE,
        amountKobo: checkout.totalKobo,
        reference: checkout.reference,
        providerRef: checkout.reference,
        cardBrand: paidWith.cardBrand,
        cardLast4: paidWith.cardLast4,
        staffId: null,
        businessDate,
      },
      select: { id: true },
    });

    const delivery = checkout.fulfilment === Fulfilment.DELIVERY;
    const mode = onlineOrderMode(checkout.fulfilment, checkout.zone);

    const online = await tx.onlineOrder.create({
      data: {
        number: onlineNumber,
        orderId: order.id,
        checkoutId: checkout.id,
        customerId,
        contactName: checkout.contactName,
        contactPhone: checkout.contactPhone,
        contactEmail: checkout.contactEmail,
        mode,
        addressStreet: delivery ? checkout.addressStreet : null,
        addressArea: delivery ? checkout.addressArea : null,
        addressTown: delivery ? checkout.addressTown : null,
        addressLandmark: delivery ? checkout.addressLandmark : null,
        addressText: delivery ? deliveryAddressText(checkout) : '',
        note: checkout.note,
        feeKobo: checkout.deliveryKobo,
        deliveryJosKobo: checkout.deliveryJosKobo,
        deliveryOutsideKobo: checkout.deliveryOutsideKobo,
        timingText: checkout.timingText,
        scheduledFor: checkout.scheduledFor,
        fulfilmentStatus: OnlineFulfilmentStatus.RECEIVED,
        paystackReference: checkout.reference,
      },
      select: { id: true },
    });

    await this.moveBarStock(tx, lines, orderNumber);

    await this.audit.record(
      {
        actor: { kind: 'SYSTEM', name: ONLINE_CHECKOUT_ACTOR },
        action: 'online.paid',
        ref: orderNumber,
        after: {
          number: onlineNumber,
          mode,
          fulfilmentStatus: OnlineFulfilmentStatus.RECEIVED,
          businessDate: formatIsoDate(businessDate),
          subtotalKobo: checkout.subtotalKobo,
          vatKobo: checkout.vatKobo,
          feeKobo: checkout.deliveryKobo,
          totalKobo: checkout.totalKobo,
          payment: paymentNumber,
          docket: docket?.ref ?? null,
        },
        reason: 'Paid online',
        channel: OrderChannel.WEB,
      },
      tx,
    );

    // C7-6: the receipt (always, Q31) and the customer's in-app item, queued
    // with the order so a payment that commits always has its receipt.
    const receiptKey = await this.mail.receipt(tx, online.id, paidWith);

    return {
      orderId: order.id,
      customerId,
      orderNumber,
      onlineNumber,
      paymentNumber,
      docketRef: docket?.ref ?? null,
      receiptKey,
    };
  }

  /**
   * Who the order belongs to (plan §7.4 step 4): the account that placed
   * it while it is live; else a verified customer by the checkout's email
   * or phone, as a guest booking links (Q35); else, with "Save my details",
   * the customer found or made by the email. Null otherwise.
   */
  private async customerFor(
    tx: Tx,
    checkout: Checkout,
  ): Promise<string | null> {
    if (checkout.customerId !== null) {
      const live = await tx.customer.findFirst({
        where: { id: checkout.customerId, deletedAt: null },
        select: { id: true },
      });

      return live?.id ?? null;
    }

    if (checkout.contactEmail === '') return null;

    const verified = await verifiedCustomerId(
      tx,
      checkout.contactEmail,
      checkout.contactPhone,
    );

    if (verified !== null) return verified;

    if (!checkout.saveDetails) return null;

    return this.customers.findOrCreateFromCheckout(tx, {
      email: checkout.contactEmail,
      name: checkout.contactName,
      phone: checkout.contactPhone,
      address:
        checkout.fulfilment === Fulfilment.DELIVERY
          ? {
              zone: checkout.zone,
              street: checkout.addressStreet,
              area: checkout.addressArea,
              town: checkout.addressTown,
              landmark: checkout.addressLandmark,
            }
          : null,
    });
  }

  /**
   * The drinks leave the Bar (`WEB_SALE`, the order number as the ref), one
   * movement per paired stock item in id order, below zero if need be. A
   * drink with no paired stock item moves nothing and is logged.
   */
  private async moveBarStock(
    tx: Tx,
    lines: ReturnType<typeof parseCheckoutLines>,
    orderNumber: string,
  ): Promise<void> {
    const drinkIds = [
      ...new Set(
        lines
          .filter((line) => line.department === Department.BAR)
          .map((line) => line.menuItemId),
      ),
    ];

    if (drinkIds.length === 0) return;

    const paired = await tx.stockItem.findMany({
      where: { menuItemId: { in: drinkIds }, kind: StockKind.BAR },
      select: { id: true, menuItemId: true },
    });
    const plan = webSalePlan(
      lines,
      new Map(
        paired.flatMap((item) =>
          item.menuItemId === null ? [] : [[item.menuItemId, item.id]],
        ),
      ),
    );

    if (plan.unpaired.length > 0) {
      this.logger.error(
        `Web order ${orderNumber} sold drinks with no paired Bar stock ` +
          `item, so no stock moved for them: ${plan.unpaired.join(', ')}.`,
      );
    }

    for (const move of plan.moves) {
      await this.ledger.move(tx, {
        stockItemId: move.stockItemId,
        location: StockLocation.BAR,
        qty: -move.qty,
        type: StockMovementType.WEB_SALE,
        ref: orderNumber,
        staffId: null,
        allowNegative: true,
      });
    }
  }
}
