import { ApiProperty } from '@nestjs/swagger';

/**
 * What the tokens sweep deleted, by table.
 *
 * Counts rather than a bare 204, because the count is the point of running
 * it: a job that reports zero every night for a month is either healthy or
 * broken, and only the numbers tell which. One per table, because the tables
 * fill at different rates and a total would hide which one is growing.
 */
export class TokensSweepResponse {
  @ApiProperty({ description: 'Expired refresh tokens deleted.', example: 12 })
  refreshTokens!: number;

  @ApiProperty({
    description: 'Expired password-reset tokens deleted.',
    example: 0,
  })
  passwordResetTokens!: number;

  @ApiProperty({
    description: 'One-time codes deleted, a day or more past their expiry.',
    example: 0,
  })
  otpCodes!: number;

  @ApiProperty({
    description: 'Stored Idempotency-Key responses older than 7 days deleted.',
    example: 3,
  })
  idempotencyKeys!: number;
}
