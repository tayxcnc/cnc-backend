import { ApiProperty } from '@nestjs/swagger';
import {
  StockLocation,
  StockRequestStatus,
} from '../../../generated/cnc-client';
import { REQUEST_LOCATIONS } from '../stock-request-rules';

/** A stock request as the request routes answer it. */
export class StockRequestResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'SR-000001' }) number!: string;
  @ApiProperty({ enum: REQUEST_LOCATIONS, enumName: 'StockRequestLocation' })
  location!: StockLocation;
  @ApiProperty() stockItemId!: string;
  @ApiProperty({ example: 'Rice' }) stockItemName!: string;
  @ApiProperty({ description: 'Used As.', example: 'portion' }) unit!: string;
  @ApiProperty({ description: 'Bought As.', example: 'bag' }) pack!: string;
  @ApiProperty({ description: 'How Many in One.', example: 50 })
  factor!: number;
  @ApiProperty({ description: 'Whole packs asked for.', example: 2 })
  qtyPacks!: number;
  @ApiProperty({ description: 'Whole packs sent so far.', example: 0 })
  issuedPacks!: number;
  @ApiProperty({
    description: 'Packs still wanted: 0 once Issued or Rejected.',
    example: 2,
  })
  remainingPacks!: number;
  @ApiProperty({ enum: StockRequestStatus, enumName: 'StockRequestStatus' })
  status!: StockRequestStatus;
  @ApiProperty({ description: 'The requester’s note; empty when none.' })
  note!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why the Store declined it; set only when Rejected.',
  })
  rejectReason!: string | null;
  @ApiProperty({ description: 'When it was asked for (ISO 8601, UTC).' })
  createdAt!: string;
  @ApiProperty() createdById!: string;
  @ApiProperty() createdByName!: string;
  @ApiProperty({ example: 0 }) version!: number;
}

export class StockRequestPageResponse {
  @ApiProperty({ type: StockRequestResponse, isArray: true })
  data!: StockRequestResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty({
    description:
      'Pending and Partially Issued requests at the locations the reader ' +
      'sees (and the location asked for), whatever the status and search ' +
      'filters: the screen’s "Open Requests" figure.',
  })
  openCount!: number;
}

/** What an issue sent, the request after it and the two balances. */
export class StockRequestIssueResponse {
  @ApiProperty({ type: StockRequestResponse })
  request!: StockRequestResponse;
  @ApiProperty({ description: 'Packs taken from the Store.' })
  packs!: number;
  @ApiProperty({ description: 'Units received at the request’s location.' })
  units!: number;
  @ApiProperty({ description: 'The Store balance after the issue, in packs.' })
  storeQty!: number;
  @ApiProperty({ description: 'The location’s balance after it, in units.' })
  destinationQty!: number;
}
