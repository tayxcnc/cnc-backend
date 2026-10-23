import { ApiProperty } from '@nestjs/swagger';

/**
 * What one run of the reminders sweep did. Counts, for the reason the
 * tokens sweep gives. A run that reminds nobody is the usual answer at
 * most quarter hours; `reminded` rising while `emailed` stays at zero
 * says every recent booking's customer switched reminders off, or that
 * something is wrong.
 */
export class RemindersSweepResponse {
  @ApiProperty({
    description: 'Bookings whose 24-hour reminder fell due this run.',
    example: 3,
  })
  reminded!: number;

  @ApiProperty({
    description: 'Of those, reminders queued by email.',
    example: 2,
  })
  emailed!: number;

  @ApiProperty({
    description:
      'Of those, customers who switched Reservation Reminders off: no ' +
      'email, the in-app item only.',
    example: 1,
  })
  switchedOff!: number;
}
