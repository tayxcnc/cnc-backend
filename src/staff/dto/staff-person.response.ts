import { ApiProperty } from '@nestjs/swagger';
import { StaffRole } from '../../../generated/cnc-client';

/**
 * A staff account as Staff & Access shows it (plan §5.4).
 *
 * Built field by field from the row (`toStaffPersonResponse`), so adding a
 * column to a select can never widen it. **Never the password hash or the
 * QR token**, at any depth: the token is a credential the person sees only
 * as a rendered image (plan §11).
 */
export class StaffPersonResponse {
  @ApiProperty({ example: 'clx8k2p9r0000v8n4h1q2w3e4' })
  id!: string;

  @ApiProperty({
    description: 'The staff number, from its own sequence.',
    example: 'CNC-S004',
  })
  staffNo!: string;

  @ApiProperty({ example: 'Grace James' })
  name!: string;

  @ApiProperty({
    description: 'The sign-in email, lower case.',
    example: 'grace.james@cnc.example',
  })
  email!: string;

  @ApiProperty({ enum: StaffRole, enumName: 'StaffRole' })
  role!: StaffRole;

  @ApiProperty({ description: 'False for a deactivated account.' })
  isActive!: boolean;

  @ApiProperty({
    description:
      'True until the person replaces the temporary password they were ' +
      'given.',
  })
  mustChangePassword!: boolean;

  @ApiProperty({
    description:
      'A short-lived signed link to the photo, or null when there is none ' +
      'or it could not be signed. Never stored; ask again for a fresh one.',
    type: String,
    nullable: true,
  })
  photoUrl!: string | null;

  @ApiProperty({
    description: 'The day the account was created, in Lagos (YYYY-MM-DD).',
    example: '2026-10-21',
  })
  joinedOn!: string;

  @ApiProperty({
    description:
      'When the staff ID (QR code) was last reissued; null if never. The ' +
      'code itself is never returned.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  qrRegeneratedAt!: Date | null;

  @ApiProperty({
    description: 'Send this back with the next change to the account (A8).',
    example: 3,
  })
  version!: number;
}

/** `POST /staff/people`: the new account, and its first password, once. */
export class StaffCreatedResponse {
  @ApiProperty({ type: StaffPersonResponse })
  staff!: StaffPersonResponse;

  @ApiProperty({
    description:
      'The temporary password to hand to the person in person. They must ' +
      'replace it at first sign-in. Returned once and stored nowhere in ' +
      'plain text; a lost one is replaced with the admin reset.',
    example: '3f9a-07c2-b18e-55d0-9e4a',
  })
  temporaryPassword!: string;
}

/** `GET /staff/people`: one page of accounts. */
export class StaffPageResponse {
  @ApiProperty({ type: StaffPersonResponse, isArray: true })
  data!: StaffPersonResponse[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 14 })
  total!: number;
}
