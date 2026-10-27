import { Inject, Injectable, Logger } from '@nestjs/common';
import { CheckoutStatus } from '../../generated/cnc-client';
import { formatKobo } from '../common/money';
import { CncConfigService } from '../config/cnc.config';
import { OutboundMessagesService } from '../mail/outbound-messages.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import {
  ANONYMISED_CHECKOUT_REASON,
  SETTLEABLE_CHECKOUT_STATUSES,
  isAnonymisedContact,
  paymentMismatch,
} from './checkout-payment-rules';
import { OnlineOrderPlacementService } from '../online-orders/online-order-placement.service';
import {
  PAYSTACK_CLIENT,
  type PaystackClient,
  type VerifiedTransaction,
  paystackNeverSawIt,
} from './paystack-client';
import { cardBrandName } from './paystack-transaction';

/** How long the needs-attention email may wait for a send: a week. */
export const ATTENTION_MAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** What `confirm` did with a payment. */
export type ConfirmOutcome =
  /** No checkout has this reference: not CNC's charge, or not one it made. */
  | 'unknown'
  /** The checkout was already paid or held: nothing changed. */
  | 'unchanged'
  /** The checkout is now paid. */
  | 'paid'
  /** The payment did not match: held for a person, no order. */
  | 'needs-attention'
  /** A recheck found nothing paid yet: nothing changed. */
  | 'unpaid';

/**
 * A Paystack payment against a web checkout (plan §7.4 step 3, card
 * C7-2), whoever reports it: the webhook's `charge.success` now, the
 * checkouts sweep's re-verify from C7-5.
 *
 * 1. The checkout is found by its reference. Paid or held already: nothing
 *    changes, so a replay or a second event does nothing.
 * 2. **Paystack's verify is asked**, always, whatever the event said
 *    (TAY's webhook trusts the event; CNC does not). Paystack unreachable
 *    throws, so the delivery stays unprocessed for the payments sweep.
 * 3. **The amount check** (`paymentMismatch`): verify's success for the
 *    reference with exactly the total in `NGN`, and the event's own amount
 *    and currency the same.
 * 4. A match settles the checkout `PAID` with Paystack's paid time and the
 *    card's brand and last four, and in the same transaction writes the
 *    web order (`OnlineOrderPlacementService`, C7-3). A mismatch holds it `NEEDS_ATTENTION`
 *    with the reason, creates nothing else, and emails CNC's inbox
 *    (`CNC_CONTACT_EMAIL`); the managers' bell item is C7-7's read.
 *
 * A settle locks the checkout's row (`FOR UPDATE`) and proceeds only while
 * it is still settleable; a hold is one conditional update on the same
 * states. So two reports of one payment racing (the webhook, the
 * confirmation read, a sweep, two instances) settle it once: the loser
 * waits on the row, finds it paid or held and answers `unchanged`. The
 * unique `Payment.providerRef`, `OnlineOrder.checkoutId` and
 * `Checkout.orderId` refuse a second order even if that check were lost.
 */
@Injectable()
export class CheckoutPaymentsService {
  private readonly logger = new Logger(CheckoutPaymentsService.name);

  constructor(
    private readonly prisma: CncPrismaService,
    @Inject(PAYSTACK_CLIENT) private readonly paystack: PaystackClient,
    private readonly outbound: OutboundMessagesService,
    private readonly config: CncConfigService,
    private readonly placement: OnlineOrderPlacementService,
  ) {}

  /**
   * Confirm a payment Paystack has **reported** for `reference`: a signed
   * `charge.success` (`event` is its own transaction, `data`), or one the
   * payments sweep re-dispatches with no body (`event` undefined). A
   * reported payment that verify does not confirm is held.
   */
  async confirm(
    reference: string,
    event: VerifiedTransaction | undefined,
  ): Promise<ConfirmOutcome> {
    return this.settle(reference, { reported: true, event });
  }

  /**
   * Ask Paystack whether a checkout nobody has reported paid has been
   * (C7-3, C7-5): the confirmation read while the customer waits on it,
   * and the checkouts sweep for a checkout past its expiry. Verify not
   * answering `success` (abandoned, ongoing, failed, or a reference
   * Paystack never saw) is `unpaid` and changes nothing; a success is
   * settled or held exactly as a webhook's. Paystack unreachable throws.
   */
  async recheck(reference: string): Promise<ConfirmOutcome> {
    return this.settle(reference, { reported: false, event: undefined });
  }

  private async settle(
    reference: string,
    report: { reported: boolean; event: VerifiedTransaction | undefined },
  ): Promise<ConfirmOutcome> {
    const { event } = report;
    const checkout = await this.prisma.checkout.findUnique({
      where: { reference },
      select: { id: true, status: true, totalKobo: true },
    });

    if (checkout === null) {
      this.logger.warn(
        'A Paystack payment named a reference no checkout holds.',
      );
      return 'unknown';
    }

    if (!SETTLEABLE_CHECKOUT_STATUSES.includes(checkout.status)) {
      return 'unchanged';
    }

    let verified: VerifiedTransaction;

    try {
      verified = await this.paystack.verify(reference);
    } catch (error) {
      // Only Paystack's definite "no such transaction" means never paid.
      // An outage, a rate limit, a refused key or a malformed answer throws,
      // so the sweep leaves the checkout waiting instead of expiring money
      // that may have been taken.
      if (!report.reported && paystackNeverSawIt(error)) return 'unpaid';

      throw error;
    }

    if (!report.reported && verified.status !== 'success') return 'unpaid';

    const problem = paymentMismatch(
      { reference, totalKobo: checkout.totalKobo },
      event,
      verified,
    );

    if (problem !== null) return this.hold(checkout.id, problem);

    const cardBrand =
      verified.card === undefined ? null : cardBrandName(verified.card.type);
    const cardLast4 = verified.card?.last4 ?? null;

    const placed = await this.prisma.$transaction(async (tx) => {
      // The row lock decides who settles: a second report racing this one
      // waits here, then reads the checkout this one committed as paid.
      const [locked] = await tx.$queryRaw<
        { status: CheckoutStatus; contactEmail: string }[]
      >`
        SELECT "status", "contactEmail" FROM "Checkout"
        WHERE "id" = ${checkout.id} FOR UPDATE`;

      if (
        locked === undefined ||
        !SETTLEABLE_CHECKOUT_STATUSES.includes(locked.status)
      ) {
        return null;
      }

      // The customer deleted their account while the payment was still
      // possible (an expired or failed checkout can still be paid): an
      // order with no name, phone, email or address could be cooked but
      // never delivered, and nobody could tell the payer about a refund.
      if (isAnonymisedContact(locked.contactEmail)) return 'anonymised';

      // C7-3: the order, the online order, the payment, the docket and the
      // Bar movements, in this transaction, so the money and the order
      // commit together or not at all.
      const order = await this.placement.place(tx, checkout.id, {
        cardBrand,
        cardLast4,
      });

      // Paid and its order in one update (`Checkout_order_check`).
      await tx.checkout.update({
        where: { id: checkout.id },
        data: {
          status: CheckoutStatus.PAID,
          paidAt: verified.paidAt ?? new Date(),
          cardBrand,
          cardLast4,
          orderId: order.orderId,
          ...(order.customerId === null
            ? {}
            : { customerId: order.customerId }),
        },
      });

      return order;
    });

    if (placed === null) return 'unchanged';

    if (placed === 'anonymised') {
      return this.hold(checkout.id, ANONYMISED_CHECKOUT_REASON);
    }

    this.logger.log(
      `Checkout ${checkout.id} paid: order ${placed.orderNumber}, ` +
        `${placed.onlineNumber}.`,
    );

    // The receipt (Q31, C7-6), queued with the order; never fails the
    // settle, and the messages sweep sends it if this send does not.
    await this.outbound.dispatchByKey(placed.receiptKey);

    return 'paid';
  }

  /** Hold the checkout for a person, and tell CNC's inbox. */
  private async hold(
    checkoutId: string,
    reason: string,
  ): Promise<ConfirmOutcome> {
    const inbox = this.config.contactEmail;

    const messageId = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.checkout.updateMany({
        where: { id: checkoutId, status: { in: SETTLEABLE_CHECKOUT_STATUSES } },
        data: {
          status: CheckoutStatus.NEEDS_ATTENTION,
          attentionReason: reason,
          attentionAt: new Date(),
        },
      });

      if (count === 0) return undefined;

      if (inbox === undefined) return null;

      const row = await tx.checkout.findUniqueOrThrow({
        where: { id: checkoutId },
        select: {
          reference: true,
          totalKobo: true,
          contactName: true,
          contactPhone: true,
        },
      });

      return this.outbound.enqueue(tx, {
        to: inbox,
        template: 'checkout.needs-attention',
        params: {
          reference: row.reference,
          total: formatKobo(row.totalKobo),
          reason,
          name: row.contactName,
          phone: row.contactPhone,
        },
        dedupeKey: `checkout:${checkoutId}:attention`,
        expiresAt: new Date(Date.now() + ATTENTION_MAIL_TTL_MS),
      });
    });

    if (messageId === undefined) return 'unchanged';

    // The reason may quote amounts; the reference is logged nowhere here,
    // the row id is enough to find it.
    this.logger.warn(`Checkout ${checkoutId} needs attention: ${reason}`);

    if (messageId === null) {
      this.logger.error(
        `Checkout ${checkoutId} needs attention and was not emailed: ` +
          'CNC_CONTACT_EMAIL is not set.',
      );
    } else {
      await this.outbound.dispatch(messageId);
    }

    return 'needs-attention';
  }
}
