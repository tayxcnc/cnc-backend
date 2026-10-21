import { ApiProperty } from '@nestjs/swagger';
import { AuditActorKind, StaffRole } from '../../../generated/cnc-client';

/**
 * One entry of the activity history, in plain words. **Never the raw
 * `before` and `after`** (A13, D47): `changes` is the server's port of the
 * staff app's `describeChange`.
 */
export class AuditEntryResponse {
  @ApiProperty({ example: 'clx8k2p9r0000v8n4h1q2w3e4' })
  id!: string;

  @ApiProperty({
    description: 'When it happened; an instant, the client renders it in WAT.',
    type: String,
    format: 'date-time',
  })
  at!: Date;

  @ApiProperty({ enum: AuditActorKind, enumName: 'AuditActorKind' })
  actorKind!: AuditActorKind;

  @ApiProperty({
    description:
      'Staff.id of the person who acted; null for a customer or the system.',
    type: String,
    nullable: true,
  })
  staffId!: string | null;

  @ApiProperty({
    description: 'The name as it was when they acted.',
    example: 'Ada Okafor',
  })
  actorName!: string;

  @ApiProperty({
    description:
      'The staff role as it was when they acted; null for a customer or the system.',
    enum: StaffRole,
    enumName: 'StaffRole',
    nullable: true,
  })
  actorRole!: StaffRole | null;

  @ApiProperty({ example: 'menu.save' })
  action!: string;

  @ApiProperty({ example: 'Menu Item Saved' })
  actionLabel!: string;

  @ApiProperty({ example: 'Menu & Prices' })
  module!: string;

  @ApiProperty({ type: String, nullable: true, example: 'jollof-rice' })
  ref!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Supplier price rise' })
  reason!: string | null;

  @ApiProperty({
    description: 'What the change did, one sentence each.',
    type: String,
    isArray: true,
    example: ['Description changed from blank to Smoky party jollof.'],
  })
  changes!: string[];
}

export class AuditPageResponse {
  @ApiProperty({ type: AuditEntryResponse, isArray: true })
  data!: AuditEntryResponse[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 240 })
  total!: number;
}
