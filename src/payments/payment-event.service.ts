import { Injectable, Logger } from '@nestjs/common';
import { UNIQUE_VIOLATION, isPrismaErrorCode } from '../prisma/prisma-error';
import { CncPrismaService } from '../prisma/cnc-prisma.service';

/** What `record` decided about a delivery. */
export interface RecordedDelivery {
  /** The `PaymentEvent` row, whether or not this call made it. */
  id: string;
  /** True only for the call that made the row: that call does the work. */
  isNew: boolean;
}

/**
 * The webhook ledger, copied from TAY's `PaymentEventService` (plan §8.2).
 * Paystack delivers one event more than once; the **unique index on
 * `deliveryId`** decides which delivery is the first, not a read before a
 * write, so two arriving together on two instances cannot both act.
 *
 * `processedAt` stays null until the work has finished (`markProcessed`):
 * an old row still null was acknowledged and not handled, which the
 * payments sweep (C7-5) re-dispatches.
 */
@Injectable()
export class PaymentEventService {
  private readonly logger = new Logger(PaymentEventService.name);

  constructor(private readonly prisma: CncPrismaService) {}

  async record(
    deliveryId: string,
    event: string,
    reference: string | undefined,
  ): Promise<RecordedDelivery> {
    try {
      const created = await this.prisma.paymentEvent.create({
        data: { deliveryId, event, reference: reference ?? null },
        select: { id: true },
      });

      return { id: created.id, isNew: true };
    } catch (error) {
      if (!isPrismaErrorCode(error, UNIQUE_VIOLATION)) throw error;

      const existing = await this.prisma.paymentEvent.findUniqueOrThrow({
        where: { deliveryId },
        select: { id: true },
      });

      this.logger.log(`Duplicate ${event} delivery ignored.`);

      return { id: existing.id, isNew: false };
    }
  }

  /** The work for a delivery has finished. */
  async markProcessed(id: string): Promise<void> {
    await this.prisma.paymentEvent.update({
      where: { id },
      data: { processedAt: new Date() },
    });
  }
}
