import { ApiProperty } from '@nestjs/swagger';
import {
  AssetStatus,
  MaintenanceStatus,
  TaskStatus,
} from '../../../generated/cnc-client';

/** An asset as the asset routes answer it. */
export class AssetResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'AC1' }) tag!: string;
  @ApiProperty({ example: 'Lounge air conditioner' }) name!: string;
  @ApiProperty({ example: 'Cooling' }) category!: string;
  @ApiProperty({ example: 'Lounge' }) location!: string;
  @ApiProperty({ example: 1 }) quantity!: number;
  @ApiProperty({ enum: AssetStatus, enumName: 'AssetStatus' })
  status!: AssetStatus;
  @ApiProperty({ example: 0 }) version!: number;
}

export class AssetPageResponse {
  @ApiProperty({ type: AssetResponse, isArray: true })
  data!: AssetResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

/** One status a repair passed through, and who set it. */
export class RepairHistoryResponse {
  @ApiProperty({ enum: MaintenanceStatus, enumName: 'MaintenanceStatus' })
  status!: MaintenanceStatus;
  @ApiProperty({ description: 'When (ISO 8601, UTC).' }) at!: string;
  @ApiProperty() staffId!: string;
  @ApiProperty() staffName!: string;
}

/** A task that tracks a repair. */
export class RepairTaskResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'T-000001' }) number!: string;
  @ApiProperty({ enum: TaskStatus, enumName: 'TaskStatus' })
  status!: TaskStatus;
}

/** A repair as the maintenance routes answer it. */
export class RepairResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'MT-000001' }) number!: string;
  @ApiProperty() assetId!: string;
  @ApiProperty({ example: 'POS1' }) assetTag!: string;
  @ApiProperty({ example: 'Cashier terminal' }) assetName!: string;
  @ApiProperty() vendorId!: string;
  @ApiProperty({ example: 'Jos Cooling Services' }) vendorName!: string;
  @ApiProperty({ example: 'Screen flickers' }) description!: string;
  @ApiProperty({ description: 'In kobo.', example: 0 }) costKobo!: number;
  @ApiProperty({
    description: 'The Lagos date it was reported (YYYY-MM-DD).',
    example: '2026-10-22',
  })
  reportedOn!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The Lagos date it was first Fixed or Not Fixed (YYYY-MM-DD). Set ' +
      'once and kept, even if the repair is reopened (plan §17, R3).',
  })
  resolvedOn!: string | null;
  @ApiProperty({ enum: MaintenanceStatus, enumName: 'MaintenanceStatus' })
  status!: MaintenanceStatus;
  @ApiProperty({
    type: RepairHistoryResponse,
    isArray: true,
    description: 'Every save’s status, oldest first.',
  })
  history!: RepairHistoryResponse[];
  @ApiProperty({
    type: RepairTaskResponse,
    isArray: true,
    description:
      'The tasks that track it: its follow-up, or the task it was logged for.',
  })
  tasks!: RepairTaskResponse[];
  @ApiProperty({ description: 'When it was logged (ISO 8601, UTC).' })
  createdAt!: string;
  @ApiProperty({ example: 0 }) version!: number;
}

export class RepairPageResponse {
  @ApiProperty({ type: RepairResponse, isArray: true })
  data!: RepairResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}
