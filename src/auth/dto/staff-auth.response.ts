import { ApiProperty } from '@nestjs/swagger';
import { StaffSummaryResponse } from './staff-summary.response';

/**
 * Body of staff sign-in, refresh and change-password: an access token and
 * who it belongs to.
 *
 * **No refresh token.** It travels in the httpOnly `cnc_staff_refresh_token`
 * cookie and nowhere else, so page script never holds it.
 */
export class StaffAuthResponse {
  @ApiProperty({
    description:
      'Bearer token for the Authorization header. Valid for 15 minutes; ' +
      'keep it in memory, never in storage.',
    example: 'header.payload.signature',
  })
  accessToken!: string;

  @ApiProperty({
    description: 'The signed-in staff member.',
    type: StaffSummaryResponse,
  })
  staff!: StaffSummaryResponse;
}
