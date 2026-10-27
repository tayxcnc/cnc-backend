import { ApiProperty } from '@nestjs/swagger';
import type { RetentionSweepResult } from '../retention-sweep.service';

/**
 * What one run of the retention sweep deleted (Q36). Counts, for the
 * reason the tokens sweep gives; almost every run is zero and zero until
 * CNC has a year of enquiries.
 */
export class RetentionSweepResponse implements RetentionSweepResult {
  @ApiProperty({
    description: 'Enquiries made more than 12 months ago, deleted.',
    example: 0,
  })
  enquiries!: number;

  @ApiProperty({
    description:
      'Finished shifts dated more than 2 years ago, deleted with their ' +
      'corrections. An open shift is never deleted.',
    example: 0,
  })
  attendanceRecords!: number;

  @ApiProperty({
    description:
      'Web push rows written more than 30 days ago, in any status, deleted.',
    example: 0,
  })
  pushMessages!: number;

  @ApiProperty({
    description:
      'Push devices, customers’ and staff’s, neither subscribed again nor ' +
      'delivered to for 180 days, deleted.',
    example: 0,
  })
  pushSubscriptions!: number;

  @ApiProperty({
    description:
      'True when the run stopped at its cap with rows still past their ' +
      'period; the next run continues.',
    example: false,
  })
  more!: boolean;
}
