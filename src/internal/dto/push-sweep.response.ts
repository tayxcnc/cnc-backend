import { ApiProperty } from '@nestjs/swagger';
import {
  PUSH_SWEEP_PHASES,
  type PushSweepPhase,
  type PushSweepResult,
} from '../push-sweep.service';

/** The topics the clock's phases queued this run. */
export class PushSweepQueuedResponse {
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Tables still occupied past the Free Table Reminder (PS12); null ' +
      'when the phase failed.',
    example: 0,
  })
  staleTables!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Daily digests (PS11, PS13), only between 09:00 and 10:00 in Jos; ' +
      'null when the phase failed.',
    example: 0,
  })
  dailyDigests!: number | null;
}

/**
 * What one run of the push sweep did (C10). Counts, for the reason the
 * tokens sweep gives; a phase that threw is named in `failed` and its
 * counts are null.
 */
export class PushSweepResponse implements PushSweepResult {
  @ApiProperty({ type: PushSweepQueuedResponse })
  queued!: PushSweepQueuedResponse;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Pushes delivered to at least one device this run.',
    example: 2,
  })
  delivered!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Staff pushes held until the staff window opens (off duty, off-hours).',
    example: 0,
  })
  held!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Pushes given up this run: no device, recipient gone, rejected, ' +
      'attempts spent or expired.',
    example: 0,
  })
  dropped!: number | null;

  @ApiProperty({
    enum: PUSH_SWEEP_PHASES,
    isArray: true,
    description: 'The phases that failed this run; empty when all ran.',
    example: [],
  })
  failed!: PushSweepPhase[];
}
