import { Injectable } from '@nestjs/common';
import {
  Fulfilment,
  OnlineFulfilmentStatus,
  PaymentMethod,
  type Prisma,
} from '../../generated/cnc-client';
import {
  businessAddressLine,
  readPickupAddressText,
  ZONE_LABELS,
} from '../common/delivery-address';
import { formatKobo } from '../common/money';
import { CncConfigService } from '../config/cnc.config';
import {
  orderLink,
  orderNotification,
  refundNotification,
} from '../customer-notifications/customer-notification-texts';
import { CustomerNotificationsService } from '../customer-notifications/customer-notifications.service';
import { cncPhoneForMail, firstName } from '../mail/mail-contact';
import type {
  OrderRefundMailMethod,
  OrderStatusMailKind,
} from '../mail/mail-templates';
import { OutboundMessagesService } from '../mail/outbound-messages.service';
import { parseCheckoutLines } from '../ordering/cart-pricing';
import { cardText } from '../payments/paystack-transaction';

type Tx = Prisma.TransactionClient;

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long a receipt or a refund notice may wait for a send: a week. Both
 * are a record of money, still worth having days late (as the needs-
 * attention email).
 */
export const ORDER_MONEY_MAIL_TTL_MS = 7 * 24 * HOUR_MS;

/**
 * How long "on its way" or "ready for pickup" may wait: three hours. Past
 * that the customer has the food or has called, and the email would only
 * mislead.
 */
export const ORDER_PROGRESS_MAIL_TTL_MS = 3 * HOUR_MS;

/**
 * The status email a stage change sends, if any (Q31's default, card
 * C7-6): on its way and ready for pickup ("When your order is on its way
 * or ready", the Order Updates switch's words), and a cancellation. The
 * other stages write only the in-app item; a correction to the stage the
 * order already had sends nothing.
 */
export function statusMailKind(
  status: OnlineFulfilmentStatus,
  previous: OnlineFulfilmentStatus,
): OrderStatusMailKind | null {
  if (status === previous) return null;

  switch (status) {
    case OnlineFulfilmentStatus.ON_THE_WAY:
      return 'ON_THE_WAY';
    case OnlineFulfilmentStatus.READY:
      return 'READY';
    case OnlineFulfilmentStatus.CANCELLED:
      return 'CANCELLED';
    default:
      return null;
  }
}

/**
 * Whether a status email goes (Q31): a cancellation always, as a booking's
 * cancellation does; on its way and ready only while the order's customer
 * keeps Order Updates on. A guest's order (no customer) gets them, as a
 * guest's booking gets its reminder (Q32): the guest gave the email for
 * this order and has no switch to turn off.
 */
export function sendsStatusMail(
  kind: OrderStatusMailKind,
  customer: { prefOrderUpdates: boolean } | null,
): boolean {
  return kind === 'CANCELLED' || customer === null || customer.prefOrderUpdates;
}

/**
 * A web order's messages to its customer (plan §7.4 step 5, §9.2; card
 * C7-6): the receipt when the payment writes the order, the stage changes
 * staff make, and the money given back. Each is an email to the address
 * given at checkout and, when the order belongs to a customer, an item in
 * their in-app list ("written by the same events", C6-8), both queued in
 * the event's own transaction with one dedupe key and sent after the
 * commit (`dispatch`), as `ReservationMail` does.
 *
 * - **The receipt is always emailed (Q31)**, whatever Order Updates says:
 *   `online:<id>:receipt`.
 * - **Stage changes** write the item for every stage; the email follows
 *   `statusMailKind` and `sendsStatusMail`: `online:<id>:status:<version>`,
 *   the version the command claimed, so two changes are two messages and
 *   a replay is none.
 * - **A refund is always emailed**, whichever way the money went back
 *   (Q26: card through Paystack once it accepts; Cash or Transfer once a
 *   manager records it): `online:<id>:refund:<payment id>`.
 *
 * A deleted account's orders (Q36) have no email left and get no item
 * (`CustomerNotificationsService.record` skips them).
 */
@Injectable()
export class OnlineOrderMail {
  constructor(
    private readonly outbound: OutboundMessagesService,
    private readonly notifications: CustomerNotificationsService,
    private readonly config: CncConfigService,
  ) {}

  /**
   * The receipt of a paid web order, from its checkout as paid, in the
   * transaction that writes the order. Returns the dedupe key for
   * `dispatch`.
   */
  async receipt(
    tx: Tx,
    onlineOrderId: string,
    card: { cardBrand: string | null; cardLast4: string | null },
  ): Promise<string> {
    const online = await this.online(tx, onlineOrderId);
    const checkout = await tx.checkout.findUniqueOrThrow({
      where: { id: online.checkoutId },
    });
    const lines = parseCheckoutLines(checkout.lines);
    const dedupeKey = `online:${online.id}:receipt`;

    if (online.customerId !== null) {
      await this.notifications.record(
        tx,
        online.customerId,
        orderNotification(
          OnlineFulfilmentStatus.RECEIVED,
          online.orderNumber,
          lines.map((line) => line.name),
        ),
        dedupeKey,
      );
    }

    if (online.contactEmail === '') return dedupeKey;

    const delivery = checkout.fulfilment === Fulfilment.DELIVERY;

    await this.outbound.enqueue(tx, {
      to: online.contactEmail,
      template: 'order.receipt',
      params: {
        number: online.orderNumber,
        guestName: firstName(online.contactName),
        whereLabel: delivery ? 'Delivering to' : 'Pickup',
        where: delivery ? online.addressText : await readPickupAddressText(tx),
        timing: online.timingText,
        card: cardText(card.cardBrand, card.cardLast4) ?? '',
        lines: lines.map((line) => ({
          qty: line.qty,
          name: line.name,
          option: line.option,
          amount: formatKobo(line.unitPriceKobo * line.qty),
        })),
        subtotal: formatKobo(checkout.subtotalKobo),
        vatLabel: `VAT (${checkout.vatBps / 100}%)`,
        vat: formatKobo(checkout.vatKobo),
        deliveryLabel:
          delivery && checkout.zone !== null
            ? `Delivery, ${ZONE_LABELS[checkout.zone]}`
            : 'Pickup',
        delivery: delivery ? formatKobo(checkout.deliveryKobo) : 'Free',
        total: formatKobo(checkout.totalKobo),
        trackUrl: this.trackUrl(online),
        phone: await cncPhoneForMail(tx),
      },
      dedupeKey,
      expiresAt: new Date(Date.now() + ORDER_MONEY_MAIL_TTL_MS),
    });

    return dedupeKey;
  }

  /**
   * The messages for a stage change staff just wrote (`online.status`,
   * `online.correctStatus`, `online.cancel`), in the command's
   * transaction, after the change. Null when the stage did not change.
   */
  async statusChanged(
    tx: Tx,
    onlineOrderId: string,
    previous: OnlineFulfilmentStatus,
  ): Promise<string | null> {
    const online = await this.online(tx, onlineOrderId);
    const status = online.fulfilmentStatus;

    if (status === previous) return null;

    const dedupeKey = `online:${online.id}:status:${online.version}`;

    if (online.customerId !== null) {
      const lines = await tx.orderLine.findMany({
        where: { orderId: online.orderId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { name: true },
      });

      await this.notifications.record(
        tx,
        online.customerId,
        orderNotification(
          status,
          online.orderNumber,
          lines.map((line) => line.name),
        ),
        dedupeKey,
      );
    }

    const kind = statusMailKind(status, previous);

    if (kind === null || online.contactEmail === '') return dedupeKey;

    const customer =
      online.customerId === null
        ? null
        : await tx.customer.findUnique({
            where: { id: online.customerId },
            select: { prefOrderUpdates: true },
          });

    if (!sendsStatusMail(kind, customer)) return dedupeKey;

    const place =
      kind === 'ON_THE_WAY'
        ? online.addressText
        : kind === 'READY'
          ? await businessAddressLine(tx)
          : '';

    await this.outbound.enqueue(tx, {
      to: online.contactEmail,
      template: 'order.status',
      params: {
        number: online.orderNumber,
        guestName: firstName(online.contactName),
        kind,
        place,
        phone: await cncPhoneForMail(tx),
        trackUrl: this.trackUrl(online),
      },
      dedupeKey,
      ...(kind === 'CANCELLED'
        ? {}
        : { expiresAt: new Date(Date.now() + ORDER_PROGRESS_MAIL_TTL_MS) }),
    });

    return dedupeKey;
  }

  /**
   * The notice of money given back (`amountKobo` positive), in the
   * transaction that records it as given: `online.balance` for Cash or
   * Transfer, the refund's `SENT` for a card.
   */
  async refunded(
    tx: Tx,
    onlineOrderId: string,
    refund: {
      paymentId: string;
      amountKobo: number;
      method: OrderRefundMailMethod;
    },
  ): Promise<string> {
    const online = await this.online(tx, onlineOrderId);
    const dedupeKey = `online:${online.id}:refund:${refund.paymentId}`;
    const amount = formatKobo(refund.amountKobo);

    if (online.customerId !== null) {
      await this.notifications.record(
        tx,
        online.customerId,
        refundNotification(online.orderNumber, amount, refund.method),
        dedupeKey,
      );
    }

    if (online.contactEmail === '') return dedupeKey;

    const paid =
      refund.method === 'CARD'
        ? await tx.payment.findFirst({
            where: {
              orderId: online.orderId,
              method: PaymentMethod.ONLINE,
              amountKobo: { gt: 0 },
            },
            orderBy: { createdAt: 'asc' },
            select: { cardBrand: true, cardLast4: true },
          })
        : null;

    await this.outbound.enqueue(tx, {
      to: online.contactEmail,
      template: 'order.refund',
      params: {
        number: online.orderNumber,
        guestName: firstName(online.contactName),
        amount,
        method: refund.method,
        card:
          paid === null ? '' : (cardText(paid.cardBrand, paid.cardLast4) ?? ''),
        phone: await cncPhoneForMail(tx),
      },
      dedupeKey,
      expiresAt: new Date(Date.now() + ORDER_MONEY_MAIL_TTL_MS),
    });

    return dedupeKey;
  }

  /** Send the queued emails after the commit. Never throws. */
  async dispatch(...dedupeKeys: (string | null)[]): Promise<void> {
    for (const key of dedupeKeys) {
      if (key !== null) await this.outbound.dispatchByKey(key);
    }
  }

  private async online(tx: Tx, id: string) {
    const online = await tx.onlineOrder.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        orderId: true,
        checkoutId: true,
        customerId: true,
        contactName: true,
        contactEmail: true,
        addressText: true,
        timingText: true,
        fulfilmentStatus: true,
        version: true,
      },
    });
    const order = await tx.order.findUniqueOrThrow({
      where: { id: online.orderId },
      select: { number: true },
    });

    return { ...online, orderNumber: order.number };
  }

  /** The order in the customer's account; a guest has no account to open. */
  private trackUrl(online: {
    customerId: string | null;
    orderNumber: string;
  }): string | null {
    return online.customerId === null
      ? null
      : (this.config.buildWebUrl(orderLink(online.orderNumber)) ?? null);
  }
}
