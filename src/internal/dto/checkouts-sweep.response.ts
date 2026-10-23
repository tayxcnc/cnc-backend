import { ApiProperty } from '@nestjs/swagger';
import type { CheckoutsSweepResult } from '../../payments/payment-sweeps.service';

/**
 * What one run of the checkouts sweep did. Counts, for the reason the
 * tokens sweep gives. `paid` above zero means webhooks are not arriving
 * (check the dashboard's webhook URL); `unreachable` that never falls
 * means Paystack cannot be reached from the service.
 */
export class CheckoutsSweepResponse implements CheckoutsSweepResult {
  @ApiProperty({ description: 'Overdue checkouts asked about.', example: 3 })
  checked!: number;

  @ApiProperty({
    description: 'Of those, paid after all: their orders were written.',
    example: 0,
  })
  paid!: number;

  @ApiProperty({
    description: 'Of those, paid wrongly: held as Needs Attention.',
    example: 0,
  })
  held!: number;

  @ApiProperty({ description: 'Of those, never paid: expired.', example: 3 })
  expired!: number;

  @ApiProperty({
    description: 'Of those, left waiting: Paystack could not be reached.',
    example: 0,
  })
  unreachable!: number;
}
