import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  OnlineRefundStatus,
  OrderChannel,
  type Prisma,
} from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { MoneyControlService } from '../money-control/money-control.service';
import {
  PAYSTACK_CLIENT,
  type PaystackClient,
  PaystackRefusedError,
} from '../payments/paystack-client';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { OnlineOrderMail } from './online-order-mail';
import { REFUND_NOT_UNCONFIRMED_MESSAGE } from './online-order-messages';

type Tx = Prisma.TransactionClient;

/** The longest Paystack message kept on a refused refund. */
const PROVIDER_MESSAGE_MAX_LENGTH = 300;

/** A refund a manager found missing from Paystack's dashboard. */
const NOT_SENT_PROVIDER_MESSAGE =
  'Not in the Paystack dashboard, as a manager recorded.';

/**
 * How long a refund may stay `SENDING` before a manager may resolve it:
 * two minutes, far beyond the client's 10-second timeout, so a send still
 * waiting for Paystack is never resolved under it.
 */
export const REFUND_SENDING_STUCK_MS = 2 * 60 * 1000;

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
 *   Cash or Transfer. By the founder's decision of 2026-10-24 (C8-0) the
 *   refusal no longer counts toward the Daily Approval Limit: in the same
 *   transaction, a release row gives back exactly what the decision's
 *   ledger row counted, on that row's person and business date
 *   (`MoneyControlService.releaseCounted`). The ledger stays append-only:
 *   the first row stays and the release is a new one. The Cash or
 *   Transfer that pays the refund then counts once, as the real decision.
 * - **No answer** (`UNCONFIRMED`): Paystack may have queued the refund,
 *   so the payment stays recorded and nothing resends it; a person checks
 *   Paystack's dashboard. It keeps counting until a manager resolves it:
 *   shown in the dashboard, it still counts; not shown, it is undone and
 *   released as a refusal is.
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
    private readonly mail: OnlineOrderMail,
    private readonly money: MoneyControlService,
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

      const noticeKey = await this.prisma.$transaction(async (tx) => {
        await this.accepted(tx, refund, queued.refundId, queued.status);
        await this.recordOutcome(tx, actor, order.number, ipAddress, {
          status: OnlineRefundStatus.SENT,
          amountKobo: refund.amountKobo,
          providerRefundId: queued.refundId,
        });

        return this.notice(tx, refund);
      });

      await this.mail.dispatch(noticeKey);

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
      const refund = await this.undone(
        tx,
        refundId,
        [OnlineRefundStatus.SENDING],
        error.providerMessage,
      );

      // A manager resolved it first (stuck past `REFUND_SENDING_STUCK_MS`):
      // their record stands, and nothing is undone or released twice.
      if (refund === null) return;

      await this.recordOutcome(tx, actor, orderNumber, ipAddress, {
        status: OnlineRefundStatus.REFUSED,
        amountKobo: refund.amountKobo,
      });
    });
  }

  /**
   * A manager's record of what Paystack's dashboard shows for a refund
   * whose answer never arrived (`UNCONFIRMED`), or one left `SENDING` by
   * an instance that died mid-call (older than `REFUND_SENDING_STUCK_MS`),
   * in the caller's transaction, after the order's claim: shown there,
   * it is `SENT` with Paystack's id and the customer is told; not shown,
   * it is undone as a refusal is, so the money is owed again for Cash or
   * Transfer, and its count toward the Daily Approval Limit is released
   * (C8-0). Shown, it keeps counting: the money moved. Answers the
   * notice's key, or null. A late answer from Paystack that moved the
   * refund out of the status the caller read is 409 with
   * {@link REFUND_NOT_UNCONFIRMED_MESSAGE}, and nothing is undone.
   */
  async resolve(
    tx: Tx,
    refund: Prisma.OnlineRefundGetPayload<object>,
    shown: { providerRefundId: string } | null,
  ): Promise<string | null> {
    if (shown === null) {
      const undone = await this.undone(
        tx,
        refund.id,
        [refund.status],
        NOT_SENT_PROVIDER_MESSAGE,
      );

      if (undone === null) {
        throw new ConflictException(REFUND_NOT_UNCONFIRMED_MESSAGE);
      }

      return null;
    }

    await this.accepted(tx, refund, shown.providerRefundId, null);

    return this.notice(tx, refund);
  }

  /**
   * Paystack has the refund: `SENT` with its id, kept on the refund and,
   * as `paystack-refund-<id>`, on its payment's unique `providerRef`.
   */
  private async accepted(
    tx: Tx,
    refund: Prisma.OnlineRefundGetPayload<object>,
    providerRefundId: string,
    providerStatus: string | null,
  ): Promise<void> {
    await tx.onlineRefund.update({
      where: { id: refund.id },
      data: {
        status: OnlineRefundStatus.SENT,
        providerRefundId,
        providerStatus,
        sentAt: refund.sentAt ?? new Date(),
      },
    });
    await tx.payment.update({
      where: { id: refund.paymentId },
      data: { providerRef: `${REFUND_PROVIDER_REF_PREFIX}${providerRefundId}` },
    });
  }

  /**
   * Nothing was refunded: `REFUSED` with Paystack's words, its payment
   * reversed (never deleted), and the adjustments it settled opened
   * again, so the order owes the refund once more.
   */
  private async undone(
    tx: Tx,
    refundId: string,
    from: readonly OnlineRefundStatus[],
    providerMessage: string,
  ): Promise<Prisma.OnlineRefundGetPayload<object> | null> {
    // One conditional move out of the status the caller saw, so a refusal
    // and a manager's "not sent" arriving together undo the refund, and
    // release its count, once (C8-0); the loser changes nothing.
    const before = await tx.onlineRefund.findUniqueOrThrow({
      where: { id: refundId },
      select: { sentAt: true },
    });
    const moved = await tx.onlineRefund.updateMany({
      where: { id: refundId, status: { in: [...from] } },
      data: {
        status: OnlineRefundStatus.REFUSED,
        providerMessage: providerMessage.slice(0, PROVIDER_MESSAGE_MAX_LENGTH),
        sentAt: before.sentAt ?? new Date(),
      },
    });

    if (moved.count === 0) return null;

    const refund = await tx.onlineRefund.findUniqueOrThrow({
      where: { id: refundId },
    });

    await tx.payment.update({
      where: { id: refund.paymentId },
      data: { reversed: true, reversedAt: new Date() },
    });
    await tx.onlineAdjustment.updateMany({
      where: { settledPaymentId: refund.paymentId },
      data: { settledAt: null, settledPaymentId: null },
    });
    // No money moved, so the Daily Approval Limit gives back what the
    // refund's `online.balance` counted, on that decision's own day.
    await this.money.releaseCounted(
      tx,
      refund.ledgerEntryId,
      refund.amountKobo,
    );

    return refund;
  }

  /**
   * C7-6: the customer is told once Paystack has the refund, never for
   * one refused or unconfirmed.
   */
  private notice(
    tx: Tx,
    refund: Prisma.OnlineRefundGetPayload<object>,
  ): Promise<string | null> {
    return this.mail.refunded(tx, refund.onlineOrderId, {
      paymentId: refund.paymentId,
      amountKobo: refund.amountKobo,
      method: 'CARD',
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
