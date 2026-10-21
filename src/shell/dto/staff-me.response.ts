import { ApiProperty } from '@nestjs/swagger';
import { StaffRole } from '../../../generated/cnc-client';
import { STAFF_PAGES, type StaffPage } from '../staff-pages';

/**
 * `GET /staff/me`: who is signed in, for the shell (plan §5.3). Answered
 * while a password change is pending too, so a reloading app knows to show
 * the change-password screen.
 */
export class StaffMeResponse {
  @ApiProperty({ example: 'clx8k2p9r0000v8n4h1q2w3e4' })
  id!: string;

  @ApiProperty({ example: 'CNC-S004' })
  staffNo!: string;

  @ApiProperty({ example: 'Grace James' })
  name!: string;

  @ApiProperty({ example: 'grace.james@cnc.example' })
  email!: string;

  @ApiProperty({ enum: StaffRole, enumName: 'StaffRole' })
  role!: StaffRole;

  @ApiProperty({
    description: 'True until the temporary password is replaced.',
  })
  mustChangePassword!: boolean;

  @ApiProperty({
    description:
      'The screens this role may open, by their hash keys, in sidebar ' +
      'order. Display only: every route checks the role itself.',
    enum: STAFF_PAGES,
    isArray: true,
    example: ['overview', 'pos', 'online', 'reports', 'tasks', 'myid'],
  })
  pages!: StaffPage[];

  @ApiProperty({
    description: 'A short-lived signed link to the photo, or null.',
    type: String,
    nullable: true,
  })
  photoUrl!: string | null;

  @ApiProperty({ example: '2026-10-21' })
  joinedOn!: string;

  @ApiProperty({
    description:
      'The account’s version, for the person’s own photo upload (A8).',
    example: 3,
  })
  version!: number;
}
