import { Inject, Injectable, Logger } from '@nestjs/common';
import { CheckoutStatus } from '../../generated/cnc-client';
import { formatKobo } from '../common/money';
import { CncConfigService } from '../config/cnc.config';
import { OutboundMessagesService } from '../mail/outbound-messages.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import {
  SETTLEABLE_CHECKOUT_STATUSES,
  paymentMismatch,
} from './checkout-payment-rules';
import {
  PAYSTACK_CLIENT,
  type PaystackClient,
  type VerifiedTransaction,
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
  | 'needs-attention';

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
 *    card's brand and last four. A mismatch holds it `NEEDS_ATTENTION`
 *    with the reason, creates nothing else, and emails CNC's inbox
 *    (`CNC_CONTACT_EMAIL`); the managers' bell item is C7-7's read.
 *
 * Each write is one conditional update on the checkout's settleable states,
 * so two reports of one payment racing (the webhook and the sweep, two
 * instances) settle it once: the loser updates nothing and answers
 * `unchanged`.
 */
@Injectable()
export class CheckoutPaymentsService {
  private readonly logger = new Logger(CheckoutPaymentsService.name);

  constructor(
    private readonly prisma: CncPrismaService,
    @Inject(PAYSTACK_CLIENT) private readonly paystack: PaystackClient,
    private readonly outbound: OutboundMessagesService,
    private readonly config: CncConfigService,
  ) {}

  /**
   * Confirm the payment for `reference`. `event` is the webhook's own
   * transaction (`charge.success`'s `data`), or undefined for a re-verify
   * that has none.
   */
  async confirm(
    reference: string,
    event: VerifiedTransaction | undefined,
  ): Promise<ConfirmOutcome> {
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

    const verified = await this.paystack.verify(reference);
    const problem = paymentMismatch(
      { reference, totalKobo: checkout.totalKobo },
      event,
      verified,
    );

    if (problem !== null) return this.hold(checkout.id, problem);

    const paid = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.checkout.updateMany({
        where: {
          id: checkout.id,
          status: { in: SETTLEABLE_CHECKOUT_STATUSES },
        },
        data: {
          status: CheckoutStatus.PAID,
          paidAt: verified.paidAt ?? new Date(),
          cardBrand:
            verified.card === undefined
              ? null
              : cardBrandName(verified.card.type),
          cardLast4: verified.card?.last4 ?? null,
        },
      });

      // C7-3 creates the order, the online order, the payment, the docket
      // and the Bar stock movements here, in this transaction, so the money
      // and the order commit together or not at all.
      return count === 1;
    });

    return paid ? 'paid' : 'unchanged';
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
