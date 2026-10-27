import { Injectable, Logger } from '@nestjs/common';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { PushQueueService } from '../push/push-queue.service';
import { TableSessionsService } from '../reception/table-sessions.service';
import { queueDailyDigests, queueStaleTables } from './staff-clock-alerts';

/** The push sweep's phases, in the order a run takes them. */
export const PUSH_SWEEP_PHASES = [
  'staleTables',
  'dailyDigests',
  'queue',
] as const;

export type PushSweepPhase = (typeof PUSH_SWEEP_PHASES)[number];

/** What one run of the push sweep did; null where its phase failed. */
export interface PushSweepResult {
  /** Topics the clock's phases queued (a repeat of an earlier run's too). */
  queued: { staleTables: number | null; dailyDigests: number | null };
  /** Pushes delivered to at least one device. */
  delivered: number | null;
  /** Staff pushes still held for the staff window (D6). */
  held: number | null;
  /** Pushes given up: no device, recipient gone, rejected, spent, expired. */
  dropped: number | null;
  /** The phases that threw this run. */
  failed: PushSweepPhase[];
}

/**
 * `POST /internal/sweeps/push` every five minutes (C10, spec §2.7): the
 * clock's staff pushes (`staff-clock-alerts.ts`: PS12, then the daily
 * digests PS11 and PS13), then the queue's own sweep
 * (`PushQueueService.sweep`), which sends everything the requests left:
 * held pushes whose window has opened, failed ones past their backoff,
 * and the pushes only queued (PS8, PC9, the clock's own).
 *
 * **Each phase in its own try**, as TAY's notification sweep: a failed
 * phase is reported (`failed`, its counts null) and the others still run,
 * so a broken digest never stops delivery.
 */
@Injectable()
export class PushSweepService {
  private readonly logger = new Logger(PushSweepService.name);

  constructor(
    private readonly prisma: CncPrismaService,
    private readonly tables: TableSessionsService,
    private readonly queue: PushQueueService,
  ) {}

  async run(now: Date): Promise<PushSweepResult> {
    const failed: PushSweepPhase[] = [];
    const attempt = async <T>(
      phase: PushSweepPhase,
      work: () => Promise<T>,
    ): Promise<T | null> => {
      try {
        return await work();
      } catch (error) {
        failed.push(phase);
        this.logger.error(
          `Push sweep phase ${phase} failed: ` +
            `${error instanceof Error ? error.name : 'unknown error'}.`,
        );
        return null;
      }
    };

    const staleTables = await attempt('staleTables', () =>
      queueStaleTables(this.prisma, this.tables, this.queue, now),
    );
    const dailyDigests = await attempt('dailyDigests', () =>
      queueDailyDigests(this.prisma, this.queue, now),
    );
    const swept = await attempt('queue', () => this.queue.sweep(now));

    return {
      queued: { staleTables, dailyDigests },
      delivered: swept?.sent ?? null,
      held: swept?.held ?? null,
      dropped: swept === null ? null : swept.dropped + swept.expired,
      failed,
    };
  }
}
