import { ApiProperty } from '@nestjs/swagger';
import { StaffRole } from '../../../generated/cnc-client';

/**
 * The staff fields a session response carries: an allowlist, built field by
 * field from a `select` that never fetches `passwordHash` or `qrToken`, so a
 * later edit to this shape cannot carry either out.
 *
 * `mustChangePassword` is here so the app can go straight to the
 * change-password screen after sign-in instead of landing on screens that
 * answer 403. It reflects the row, not a token claim.
 *
 * `GET /staff/me` (C3-8) answers with more: the pages the role may open and
 * the photo link.
 */
export class StaffSummaryResponse {
  @ApiProperty({
    description: 'Staff.id: the subject of the access token.',
    example: 'clx8k2p9r0000v8n4h1q2w3e4',
  })
  id!: string;

  @ApiProperty({ description: 'Staff number.', example: 'CNC-S001' })
  staffNo!: string;

  @ApiProperty({ description: 'Display name.', example: 'Ada Okafor' })
  name!: string;

  @ApiProperty({
    description: 'Work email, as stored: trimmed and lower case.',
    example: 'ada@cnc.example',
    format: 'email',
  })
  email!: string;

  @ApiProperty({
    description:
      'The one role this person holds, read from the account. The guards ' +
      'read it again on every request, so a change takes effect at once.',
    enum: StaffRole,
    enumName: 'StaffRole',
    example: StaffRole.CASHIER,
  })
  role!: StaffRole;

  @ApiProperty({
    description:
      'True while the account holds a password somebody else chose. Every ' +
      'staff route answers 403 except change-password, sign-out and ' +
      '`GET /staff/me` until it is changed.',
    example: false,
  })
  mustChangePassword!: boolean;
}
