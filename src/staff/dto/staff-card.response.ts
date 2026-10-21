import { ApiProperty } from '@nestjs/swagger';
import { StaffRole } from '../../../generated/cnc-client';

/**
 * A staff ID card: `GET /staff/me/card` (My Staff ID) and
 * `GET /staff/people/:id/card` (Staff & Access). What the staff app's card
 * shows: photo, name, role, staff number, status, sign-in email and the QR
 * code.
 *
 * The code arrives only as `qrSvg`, rendered on the server. The token it
 * encodes is in no field of this or any other response (plan §5.3).
 */
export class StaffCardResponse {
  @ApiProperty({ example: 'clx8k2p9r0000v8n4h1q2w3e4' })
  id!: string;

  @ApiProperty({
    description: 'The permanent staff number.',
    example: 'CNC-S001',
  })
  staffNo!: string;

  @ApiProperty({ example: 'Grace James' })
  name!: string;

  @ApiProperty({ enum: StaffRole, enumName: 'StaffRole' })
  role!: StaffRole;

  @ApiProperty({ description: 'False for a deactivated account.' })
  isActive!: boolean;

  @ApiProperty({ example: 'grace.james@cnc.example' })
  email!: string;

  @ApiProperty({
    description: 'A short-lived signed link to the photo, or null.',
    nullable: true,
    type: String,
  })
  photoUrl!: string | null;

  @ApiProperty({ description: 'YYYY-MM-DD.', example: '2026-10-21' })
  joinedOn!: string;

  @ApiProperty({
    description:
      'The attendance QR code as an SVG document, ready for an img tag as a ' +
      'data URI. A reissued ID replaces it at once.',
    example: '<svg xmlns="http://www.w3.org/2000/svg" …></svg>',
  })
  qrSvg!: string;
}
