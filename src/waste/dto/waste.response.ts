import { ApiProperty } from '@nestjs/swagger';
import {
  StockLocation,
  WasteReason,
  WasteStatus,
} from '../../../generated/cnc-client';

/** A waste entry as the waste routes answer it. */
export class WasteResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'W-000001' }) number!: string;
  @ApiProperty({ enum: StockLocation, enumName: 'StockLocation' })
  location!: StockLocation;
  @ApiProperty() stockItemId!: string;
  @ApiProperty({ example: 'Rice' }) stockItemName!: string;
  @ApiProperty({
    description:
      'What the quantity counts: the item’s pack ("Bought As") at the ' +
      'Store, its unit ("Used As") at the Kitchen and the Bar.',
    example: 'portion',
  })
  measure!: string;
  @ApiProperty({ example: 2 }) qty!: number;
  @ApiProperty({ enum: WasteReason, enumName: 'WasteReason' })
  reason!: WasteReason;
  @ApiProperty({ description: 'What happened; empty when none.' })
  note!: string;
  @ApiProperty({ enum: WasteStatus, enumName: 'WasteStatus' })
  status!: WasteStatus;
  @ApiProperty({
    description:
      'What the write-off is worth, in kobo, as its location holds it ' +
      '(Q25: Store waste per pack, at the latest approved pack cost; the ' +
      'Kitchen per portion; the Bar at menu price): set when it is logged, ' +
      'corrected or approved.',
    example: 140000,
  })
  valueKobo!: number;
  @ApiProperty({ description: 'When it was logged (ISO 8601, UTC).' })
  createdAt!: string;
  @ApiProperty() createdById!: string;
  @ApiProperty() createdByName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Who approved, rejected or last set its status.',
  })
  decidedById!: string | null;
  @ApiProperty({ type: String, nullable: true })
  decidedByName!: string | null;
  @ApiProperty({ example: 0 }) version!: number;
}

export class WastePageResponse {
  @ApiProperty({ type: WasteResponse, isArray: true })
  data!: WasteResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty({
    description:
      'Pending entries at the locations the reader sees (and the location ' +
      'asked for), whatever the view and search: the screen’s "Waste ' +
      'Awaiting Review" figure.',
  })
  pendingCount!: number;
}
