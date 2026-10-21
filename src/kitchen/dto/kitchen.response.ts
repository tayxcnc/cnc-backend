import { ApiProperty } from '@nestjs/swagger';
import { CrosscheckStatus } from '../kitchen-crosscheck';

/** One portion line, with the item's name and unit for the screen. */
export class KitchenLineResponse {
  @ApiProperty() stockItemId!: string;
  @ApiProperty() stockItemName!: string;
  @ApiProperty({ example: 'portion' }) unit!: string;
  @ApiProperty({ example: 2 }) qty!: number;
}

/** A kitchen entry: the portions recorded against one docket. */
export class KitchenEntryResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'KOT-CNCR-000001' }) docketRef!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty({ example: 'CNCR-000001' }) orderNumber!: string;
  @ApiProperty({
    example: 1,
    description: 'The docket revision the portions were recorded against.',
  })
  revision!: number;
  @ApiProperty({
    example: '2026-10-21',
    description: 'The kitchen date (YYYY-MM-DD).',
  })
  businessDate!: string;
  @ApiProperty({ type: KitchenLineResponse, isArray: true })
  lines!: KitchenLineResponse[];
  @ApiProperty({ description: 'Who saved it last.' }) staffId!: string;
  @ApiProperty() staffName!: string;
  @ApiProperty({ description: 'When it was first recorded.' })
  createdAt!: string;
  @ApiProperty({ description: 'When it was last saved.' }) updatedAt!: string;
  @ApiProperty({ description: 'Send it back to correct the entry (A8).' })
  version!: number;
}

/** `GET /staff/kitchen/entries`. */
export class KitchenEntryPageResponse {
  @ApiProperty({ type: KitchenEntryResponse, isArray: true })
  data!: KitchenEntryResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty({
    description:
      'Portions recorded across every entry that matches the query (the ' +
      'screen’s Portions Recorded), not only this page.',
  })
  portions!: number;
}

/** A kitchen day: whether it is closed, and whether the kitchen may still write it. */
export class KitchenDayResponse {
  @ApiProperty({ example: '2026-10-21' }) businessDate!: string;
  @ApiProperty() closed!: boolean;
  @ApiProperty({ type: String, nullable: true }) closedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) closedByName!: string | null;
  @ApiProperty({
    description:
      'True for any day but an open today: its entries are then manager ' +
      'corrections with a reason.',
  })
  locked!: boolean;
}

/** One portion in the crosscheck's comparison. */
export class CrosscheckLineResponse {
  @ApiProperty() stockItemId!: string;
  @ApiProperty() stockItemName!: string;
  @ApiProperty() qty!: number;
}

/** One docket compared with what the kitchen recorded. */
export class CrosscheckRowResponse {
  @ApiProperty({ example: 'KOT-CNCR-000001' }) ref!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty({ example: 'CNCR-000001' }) orderNumber!: string;
  @ApiProperty({ example: '2026-10-21' }) businessDate!: string;
  @ApiProperty({
    description: 'The POS revision; 0 for a kitchen entry with no docket.',
  })
  revision!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The kitchen entry’s revision; null when none was recorded.',
  })
  kitchenRevision!: number | null;
  @ApiProperty({
    enum: Object.values(CrosscheckStatus),
    enumName: 'CrosscheckStatus',
  })
  status!: CrosscheckStatus;
  @ApiProperty({ type: CrosscheckLineResponse, isArray: true })
  expected!: CrosscheckLineResponse[];
  @ApiProperty({ type: CrosscheckLineResponse, isArray: true })
  actual!: CrosscheckLineResponse[];
}

/** `GET /staff/reports/kitchen-crosscheck`. */
export class CrosscheckPageResponse {
  @ApiProperty({ type: CrosscheckRowResponse, isArray: true })
  data!: CrosscheckRowResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty({ example: '2026-10-21' }) from!: string;
  @ApiProperty({ example: '2026-10-21' }) to!: string;
  @ApiProperty({
    description: 'Rows in the range whose result is not Matched.',
  })
  notMatched!: number;
}
