import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, MaxLength, ValidateIf } from 'class-validator';
import { AdminReason } from '../../common/admin-reason';
import { Checked, requiredText } from '../../common/checked';
import {
  LINES_DUPLICATE_MESSAGE,
  LINES_EMPTY_MESSAGE,
  LINES_QTY_MESSAGE,
  POSITIVE_STOCK_LINES,
  ValidLines,
} from '../../common/command-lines';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { OptionalText } from '../../common/optional-text';
import { trimText } from '../../common/trim-text';
import {
  SETTABLE_PURCHASE_STATUSES,
  type SettablePurchaseStatus,
} from '../purchase-rules';
import {
  ACTIVE_VENDOR_MESSAGE,
  PURCHASE_VIEW_MESSAGE,
  PURCHASING_NOTE_MAX_LENGTH,
  STATUS_RECEIVE_MESSAGE,
} from '../purchasing-messages';

/**
 * Each field answers one sentence at most (`Checked`, `ValidLines`): the
 * staff app joins every message of a 400 into what the screen shows, and
 * the demo's sentence must show once, as it stands (A7).
 */

/**
 * One line of a requisition. The lines stay plain objects (`ValidLines`):
 * the item list's own sentences are checked here, and each line's vendor,
 * item and cost against the database in the service, in the demo's order.
 */
export class PurchaseLineRequest {
  @ApiProperty({ description: 'StockItem.id: any Kitchen or Bar item.' })
  stockItemId!: string;

  @ApiProperty({
    description: 'Whole packs ("Bought As") ordered.',
    minimum: 1,
    example: 2,
  })
  qty!: number;

  @ApiProperty({
    description:
      'The cost of one pack, in kobo: a whole number above zero. Checked ' +
      'with the line’s item, in the command’s own sentence.',
    minimum: 1,
    example: 7000000,
  })
  costKobo!: number;

  @ApiPropertyOptional({
    description:
      'Vendor.id: an active vendor. On a new requisition a line without one ' +
      'takes the requisition’s `vendorId`, as in the staff app; an edit ' +
      'names it on every line.',
  })
  vendorId?: string;
}

/**
 * The line-list rules: the demo's `positiveLines` only (empty, duplicates,
 * quantities). Each line's item is checked in the service with its cost,
 * in the command's order against the vendor (`purchase.create` asks for
 * the vendor first), so a line with neither answers the vendor sentence on
 * a create, as in the demo.
 */
const purchaseLines = () =>
  ValidLines({ ...POSITIVE_STOCK_LINES, idMessage: null });

const LINES_DESCRIPTION =
  `"${LINES_EMPTY_MESSAGE}", "${LINES_DUPLICATE_MESSAGE}" for an item named ` +
  `twice, "${LINES_QTY_MESSAGE}"; then, line by line, the vendor and the ` +
  `item and cost.`;

/** Body of `POST /staff/purchases`: `purchase.create`. */
export class CreatePurchaseRequest {
  @ApiPropertyOptional({
    description:
      'Vendor.id for every line that names none (the staff app’s header ' +
      'vendor). The requisition’s vendor is its first line’s.',
  })
  @ValidateIf(isSent)
  @Checked(requiredText(ACTIVE_VENDOR_MESSAGE, 64, ACTIVE_VENDOR_MESSAGE))
  vendorId?: string;

  @ApiProperty({
    type: PurchaseLineRequest,
    isArray: true,
    description: LINES_DESCRIPTION,
  })
  @purchaseLines()
  lines!: PurchaseLineRequest[];

  @ApiPropertyOptional({
    description: 'The procurement note.',
    maxLength: PURCHASING_NOTE_MAX_LENGTH,
    example: 'Two bags for next service',
  })
  @OptionalText('note', PURCHASING_NOTE_MAX_LENGTH)
  note?: string;
}

/** Body of `PUT /staff/purchases/:id`: `purchase.edit`, a manager's correction. */
export class EditPurchaseRequest extends VersionedWriteDto {
  @ApiProperty({
    type: PurchaseLineRequest,
    isArray: true,
    description:
      `${LINES_DESCRIPTION} Every line names its vendor. On a purchase ` +
      'with received goods the Store moves by each line’s new quantity less ' +
      'what was received.',
  })
  @purchaseLines()
  lines!: PurchaseLineRequest[];

  @ApiPropertyOptional({
    description: 'The procurement note; empty when left out, as in the demo.',
    maxLength: PURCHASING_NOTE_MAX_LENGTH,
  })
  @OptionalText('note', PURCHASING_NOTE_MAX_LENGTH)
  note?: string;

  @AdminReason('Why the requisition is corrected.')
  reason!: string;
}

/** Body of `POST /staff/purchases/:id/approve`. */
export class ApprovePurchaseRequest extends VersionedWriteDto {}

/** Body of `POST /staff/purchases/:id/reject`. */
export class RejectPurchaseRequest extends VersionedWriteDto {
  @ApiPropertyOptional({
    description: 'Why, for the history; the demo asks for none.',
    maxLength: PURCHASING_NOTE_MAX_LENGTH,
  })
  @OptionalText('reason', PURCHASING_NOTE_MAX_LENGTH)
  reason?: string;
}

/** Body of `POST /staff/purchases/:id/status`: `purchase.status`, a manager's correction. */
export class PurchaseStatusRequest extends VersionedWriteDto {
  @ApiProperty({
    enum: SETTABLE_PURCHASE_STATUSES,
    enumName: 'SettablePurchaseStatus',
    description:
      'Pending, Approved, Rejected or Cancelled. Fulfilled is set only by ' +
      'receiving ("Use Receive goods to record stock receipt.").',
  })
  @IsIn(SETTABLE_PURCHASE_STATUSES, { message: STATUS_RECEIVE_MESSAGE })
  status!: SettablePurchaseStatus;

  @AdminReason('Why the status is corrected.')
  reason!: string;
}

/** Body of `POST /staff/purchases/:id/archive`: `purchase.archive`. */
export class ArchivePurchaseRequest extends VersionedWriteDto {
  @AdminReason('Why the requisition is removed from active work.')
  reason!: string;
}

/** Body of `POST /staff/purchases/:id/receive`: `purchase.receive`. */
export class ReceivePurchaseRequest extends VersionedWriteDto {}

/** The Purchasing screen's two views. */
export const PURCHASE_VIEWS = ['ACTIVE', 'HISTORY'] as const;

export type PurchaseView = (typeof PURCHASE_VIEWS)[number];

/** `GET /staff/purchases`. */
export class PurchasesQuery extends PaginationQuery {
  @ApiPropertyOptional({
    enum: PURCHASE_VIEWS,
    enumName: 'PurchaseView',
    description:
      'ACTIVE: neither archived nor Fulfilled, Rejected or Cancelled. ' +
      'HISTORY: the rest. Both when left out.',
  })
  @ValidateIf(isSent)
  @IsIn(PURCHASE_VIEWS, { message: PURCHASE_VIEW_MESSAGE })
  view?: PurchaseView;

  @ApiPropertyOptional({
    description:
      'Part of a requisition number, its note or a line’s vendor name, any ' +
      'case.',
  })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: 'q must be text.' })
  @MaxLength(120, { message: 'q must be 120 characters or fewer.' })
  q?: string;
}
