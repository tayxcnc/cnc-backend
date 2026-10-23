import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  OnlineRefundStatus,
  OrderChannel,
  type Prisma,
} from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import {
  PAYSTACK_CLIENT,
  type PaystackClient,
  PaystackRefusedError,
} from '../payments/paystack-client';
import { CncPrismaService } from '../prisma/cnc-prisma.service';

/** The longest Paystack message kept on a refused refund. */
const PROVIDER_MESSAGE_MAX_LENGTH = 300;

/** The prefix of a refund payment's `providerRef`: Paystack's refund id. */
export const REFUND_PROVIDER_REF_PREFIX = 'paystack-refund-';

/**
 * Card refunds through Paystack's refund API (card C7-4, Q26's default:
 * "through Paystack; Manager within limits, Owner above; CNC absorbs the
 * fee"). `online.balance` records the refund in its own transaction,
 * limits and ledger included, as a negative `ONLINE` payment and a
 * `PENDING` `OnlineRefund`; `send` then asks Paystack, after that commit,
 * because a network call must not hold a transaction.
 *
 * - **Once.** The request that moves the refund from `PENDING` to
 *   `SENDING` (one conditional update) is the only one that calls
 *   Paystack. A retry of the same `Idempotency-Key` replays the record
 *   and finds the refund already claimed, so it never sends it again.
 * - **Accepted** (`SENT`): Paystack's refund id is kept on the refund and,
 *   as `paystack-refund-<id>`, on its payment's unique `providerRef`.
 * - **Refused** (`REFUSED`): nothing was refunded, so the payment is
 *   reversed (never deleted) and the adjustments it settled are open
 *   again: the refund is owed once more, and a manager records it as
 *   Cash or Transfer. The ledger row of the first decision stays: the
 *   ledger is append-only.
 * - **No answer** (`UNCONFIRMED`): Paystack may have queued the refund,
 *   so the payment stays recorded and nothing resends it; a person checks
 *   Paystack's dashboard.
 *
 * CNC absorbs Paystack's fee (Q26): the customer gets back exactly what
 * they are owed, and nothing is added or taken off.
 */
@Injectable()
export class OnlineRefundsService {
  private readonly logger = new Logger(OnlineRefundsService.name);

  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
    @Inject(PAYSTACK_CLIENT) private readonly paystack: PaystackClient,
  ) {}

  /**
   * Send a recorded refund to Paystack, if nobody has yet, and answer its
   * status afterwards: `SENT`, `REFUSED`, `UNCONFIRMED`, or `SENDING` while
   * another request is still waiting for Paystack.
   */
  async send(
    refundId: string,
    actor: StaffPrincipal,
    ipAddress: string,
  ): Promise<OnlineRefundStatus> {
    const claimed = await this.prisma.onlineRefund.updateMany({
      where: { id: refundId, status: OnlineRefundStatus.PENDING },
      data: { status: OnlineRefundStatus.SENDING },
    });
    const refund = await this.prisma.onlineRefund.findUniqueOrThrow({
      where: { id: refundId },
    });

    if (claimed.count === 0) return refund.status;

    const online = await this.prisma.onlineOrder.findUniqueOrThrow({
      where: { id: refund.onlineOrderId },
      select: { orderId: true },
    });
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: online.orderId },
      select: { number: true },
    });

    try {
      const queued = await this.paystack.refund({
        transactionReference: refund.transactionReference,
        amountKobo: refund.amountKobo,
        merchantNote: `CNC refund for ${order.number}`,
      });

      await this.prisma.$transaction(async (tx) => {
        await tx.onlineRefund.update({
          where: { id: refundId },
          data: {
            status: OnlineRefundStatus.SENT,
            providerRefundId: queued.refundId,
            providerStatus: queued.status,
            sentAt: new Date(),
          },
        });
        await tx.payment.update({
          where: { id: refund.paymentId },
          data: {
            providerRef: `${REFUND_PROVIDER_REF_PREFIX}${queued.refundId}`,
          },
        });
        await this.recordOutcome(tx, actor, order.number, ipAddress, {
          status: OnlineRefundStatus.SENT,
          amountKobo: refund.amountKobo,
          providerRefundId: queued.refundId,
        });
      });

      return OnlineRefundStatus.SENT;
    } catch (error) {
      if (error instanceof PaystackRefusedError) {
        await this.refused(refundId, actor, order.number, ipAddress, error);

        return OnlineRefundStatus.REFUSED;
      }

      this.logger.error(
        `Refund ${refundId} for ${order.number}: Paystack's answer did not ` +
          'arrive; the refund is kept as unconfirmed for a person to check.',
        error instanceof Error ? error.stack : undefined,
      );

      await this.prisma.$transaction(async (tx) => {
        await tx.onlineRefund.update({
          where: { id: refundId },
          data: { status: OnlineRefundStatus.UNCONFIRMED, sentAt: new Date() },
        });
        await this.recordOutcome(tx, actor, order.number, ipAddress, {
          status: OnlineRefundStatus.UNCONFIRMED,
          amountKobo: refund.amountKobo,
        });
      });

      return OnlineRefundStatus.UNCONFIRMED;
    }
  }

  /**
   * Paystack said no: the refund is `REFUSED` with Paystack's words, its
   * payment reversed, and the adjustments it settled opened again, so the
   * order owes the refund once more.
   */
  private async refused(
    refundId: string,
    actor: StaffPrincipal,
    orderNumber: string,
    ipAddress: string,
    error: PaystackRefusedError,
  ): Promise<void> {
    this.logger.warn(
      `Paystack refused refund ${refundId} for ${orderNumber} ` +
        `(${error.providerStatus}).`,
    );

    await this.prisma.$transaction(async (tx) => {
      const refund = await tx.onlineRefund.update({
        where: { id: refundId },
        data: {
          status: OnlineRefundStatus.REFUSED,
          providerMessage: error.providerMessage.slice(
            0,
            PROVIDER_MESSAGE_MAX_LENGTH,
          ),
          sentAt: new Date(),
        },
      });

      await tx.payment.update({
        where: { id: refund.paymentId },
        data: { reversed: true, reversedAt: new Date() },
      });
      await tx.onlineAdjustment.updateMany({
        where: { settledPaymentId: refund.paymentId },
        data: { settledAt: null, settledPaymentId: null },
      });
      await this.recordOutcome(tx, actor, orderNumber, ipAddress, {
        status: OnlineRefundStatus.REFUSED,
        amountKobo: refund.amountKobo,
      });
    });
  }

  /** The refund's audit row, filed under the bill like every online command. */
  private recordOutcome(
    tx: Prisma.TransactionClient,
    actor: StaffPrincipal,
    orderNumber: string,
    ipAddress: string,
    after: Record<string, string | number>,
  ): Promise<void> {
    return this.audit.record(
      {
        actor: staffActor(actor),
        action: 'online.refund',
        ref: orderNumber,
        after,
        channel: OrderChannel.WEB,
        ipAddress,
      },
      tx,
    );
  }
}
