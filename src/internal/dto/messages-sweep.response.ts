import { ApiProperty } from '@nestjs/swagger';

/**
 * What one run of the messages sweep did. Counts, for the reason the tokens
 * sweep gives: a job that reports the same numbers every run is either
 * healthy or broken, and only the numbers tell which. `waiting` that never
 * falls means mail is not configured on this service.
 */
export class MessagesSweepResponse {
  @ApiProperty({ description: 'Messages sent this run.', example: 2 })
  sent!: number;

  @ApiProperty({
    description: 'Sends that failed this run (retried up to 3 attempts).',
    example: 0,
  })
  failed!: number;

  @ApiProperty({
    description: 'Messages left waiting because mail is not configured.',
    example: 0,
  })
  waiting!: number;

  @ApiProperty({
    description: 'Messages given up because their time ran out.',
    example: 1,
  })
  expired!: number;
}
