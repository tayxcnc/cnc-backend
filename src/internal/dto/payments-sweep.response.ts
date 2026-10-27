import { ApiProperty } from '@nestjs/swagger';
import type { PaymentsSweepResult } from '../../payments/payment-sweeps.service';

/**
 * What one run of the payments sweep did. Counts, for the reason the
 * tokens sweep gives. Almost every run is zero and zero: a webhook is
 * handled within seconds of its answer. `failed` that keeps coming back
 * means verify cannot be reached.
 */
export class PaymentsSweepResponse implements PaymentsSweepResult {
  @ApiProperty({
    description: 'Unprocessed webhook deliveries handled again.',
    example: 0,
  })
  redispatched!: number;

  @ApiProperty({
    description: 'Deliveries whose handling failed again (kept for later).',
    example: 0,
  })
  failed!: number;
}
