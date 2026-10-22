import { ApiProperty } from '@nestjs/swagger';
import { PurchaseStatus } from '../../../generated/cnc-client';

/** One line of a requisition, with the names the screen shows. */
export class PurchaseLineResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'The line’s place in the requisition, from 0.' })
  position!: number;
  @ApiProperty() stockItemId!: string;
  @ApiProperty({ example: 'Rice' }) stockItemName!: string;
  @ApiProperty({ description: 'Bought As.', example: 'bag' }) pack!: string;
  @ApiProperty() vendorId!: string;
  @ApiProperty({ example: 'Plateau Fresh Foods' }) vendorName!: string;
  @ApiProperty({ description: 'Whole packs ordered.', example: 2 })
  qtyPacks!: number;
  @ApiProperty({ description: 'Cost of one pack, in kobo.', example: 7000000 })
  costKobo!: number;
  @ApiProperty({
    description: 'Packs received into the Store: none, or all of them.',
    example: 0,
  })
  receivedPacks!: number;
  @ApiProperty({ description: 'qtyPacks × costKobo.', example: 14000000 })
  totalKobo!: number;
}

/** A requisition as the purchase routes answer it. */
export class PurchaseResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'PR-000001' }) number!: string;
  @ApiProperty({ description: 'The first line’s vendor.' }) vendorId!: string;
  @ApiProperty({ example: 'Plateau Fresh Foods' }) vendorName!: string;
  @ApiProperty({ enum: PurchaseStatus, enumName: 'PurchaseStatus' })
  status!: PurchaseStatus;
  @ApiProperty() note!: string;
  @ApiProperty({
    description: 'Removed from active work; the record and history are kept.',
  })
  archived!: boolean;
  @ApiProperty({ description: 'When it was raised (ISO 8601, UTC).' })
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
  @ApiProperty({ description: 'The requisition’s total, in kobo.' })
  totalKobo!: number;
  @ApiProperty({ description: 'What reached the Store, in kobo.' })
  receivedValueKobo!: number;
  @ApiProperty({ type: PurchaseLineResponse, isArray: true })
  lines!: PurchaseLineResponse[];
  @ApiProperty({ example: 0 }) version!: number;
}

/** The Purchasing screen's three figures, over every requisition. */
export class PurchaseCountsResponse {
  @ApiProperty({ description: 'Pending and not archived.' })
  awaitingApproval!: number;
  @ApiProperty({ description: 'Approved and not archived.' })
  approvedNotReceived!: number;
  @ApiProperty({
    description: 'Received packs × cost over every requisition, in kobo.',
  })
  receivedValueKobo!: number;
}

export class PurchasePageResponse {
  @ApiProperty({ type: PurchaseResponse, isArray: true })
  data!: PurchaseResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty({
    type: PurchaseCountsResponse,
    description:
      'Whatever the view and search filters: the screen’s Awaiting ' +
      'Approval, Approved Not Received and Received Value.',
  })
  counts!: PurchaseCountsResponse;
}

/** What receiving moved, and the requisition after it. */
export class PurchaseReceiveResponse {
  @ApiProperty({ type: PurchaseResponse })
  purchase!: PurchaseResponse;
  @ApiProperty({
    description: 'Each item’s Store balance after receiving, in packs.',
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { clx0rice: 12 },
  })
  storeQty!: Record<string, number>;
}
