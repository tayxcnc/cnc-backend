import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Allow,
  IsEnum,
  IsIn,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  StockLocation,
  WasteReason,
  WasteStatus,
} from '../../../generated/cnc-client';
import { AdminReason } from '../../common/admin-reason';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { OptionalText } from '../../common/optional-text';
import { trimText } from '../../common/trim-text';
import { STOCK_LOCATION_MESSAGE } from '../../stock/stock-messages';
import {
  WASTE_NOTE_MAX_LENGTH,
  WASTE_STATUS_MESSAGE,
  WASTE_VIEW_MESSAGE,
} from '../waste-messages';
import { WASTE_VIEWS, type WasteView } from '../waste-rules';

/**
 * Each field answers one sentence at most (`Checked`, a single
 * class-validator decorator): the staff app joins every message of a 400
 * into what the screen shows, and the demo's sentence must show once, as
 * it stands (A7).
 *
 * The item, the quantity and the waste reason are admitted here
 * (`@Allow()`) and judged in the service, in the demo's order, because the
 * demo's sentences each cover two fields ("Enter a whole quantity and a
 * waste reason.", "Choose an item for this stock location."): checked here,
 * a request wrong in both fields would answer the sentence twice.
 */

/** Body of `POST /staff/waste`: `waste.create`. */
export class CreateWasteRequest {
  @ApiProperty({
    enum: StockLocation,
    enumName: 'StockLocation',
    description:
      'Where the stock was lost. A Kitchen user logs the Kitchen’s waste, a ' +
      'Bartender or Cashier the Bar’s, the Storekeeper the Store’s; managers ' +
      'any location.',
  })
  @IsEnum(StockLocation, { message: STOCK_LOCATION_MESSAGE })
  location!: StockLocation;

  @ApiProperty({
    type: String,
    description:
      'StockItem.id: an item the location holds. Refused with "Select a ' +
      'stock item for this location."',
  })
  @Allow()
  stockItemId!: unknown;

  @ApiProperty({
    type: Number,
    description:
      'Whole packs at the Store, whole units (portions, servings) at the ' +
      'Kitchen and the Bar, above zero.',
    minimum: 1,
    example: 2,
  })
  @Allow()
  qty!: unknown;

  @ApiProperty({
    enum: WasteReason,
    enumName: 'WasteReason',
    description:
      'Checked with the quantity, in one sentence: "Enter a whole quantity ' +
      'and a waste reason."',
  })
  @Allow()
  reason!: unknown;

  @ApiPropertyOptional({
    description: 'What happened.',
    maxLength: WASTE_NOTE_MAX_LENGTH,
    example: 'Lunch preparation',
  })
  @OptionalText('note', WASTE_NOTE_MAX_LENGTH)
  note?: string;
}

/** Body of `PUT /staff/waste/:id`: `waste.edit`, a manager's correction. */
export class EditWasteRequest extends VersionedWriteDto {
  @ApiProperty({
    enum: StockLocation,
    enumName: 'StockLocation',
    description:
      'Checked with the item, in one sentence: "Choose an item for this ' +
      'stock location."',
  })
  @Allow()
  location!: unknown;

  @ApiProperty({ type: String, description: 'StockItem.id.' })
  @Allow()
  stockItemId!: unknown;

  @ApiProperty({ type: Number, minimum: 1, example: 1 })
  @Allow()
  qty!: unknown;

  @ApiProperty({
    enum: WasteReason,
    enumName: 'WasteReason',
    description:
      'The waste reason (the demo’s `wasteReason`: `reason` is the ' +
      'correction’s). Checked with the quantity, in one sentence: "Enter a ' +
      'whole quantity and waste reason."',
  })
  @Allow()
  wasteReason!: unknown;

  @ApiPropertyOptional({
    description: 'What happened; empty when left out, as in the demo.',
    maxLength: WASTE_NOTE_MAX_LENGTH,
  })
  @OptionalText('note', WASTE_NOTE_MAX_LENGTH)
  note?: string;

  @AdminReason('Why the waste record is corrected.')
  reason!: string;
}

/** Body of `POST /staff/waste/:id/status`: `waste.status`, a manager's correction. */
export class WasteStatusRequest extends VersionedWriteDto {
  @ApiProperty({ enum: WasteStatus, enumName: 'WasteStatus' })
  @IsEnum(WasteStatus, { message: WASTE_STATUS_MESSAGE })
  status!: WasteStatus;

  @AdminReason('Why the status is corrected.')
  reason!: string;
}

/** Body of `POST /staff/waste/:id/approve`. */
export class ApproveWasteRequest extends VersionedWriteDto {}

/** Body of `POST /staff/waste/:id/reject`. */
export class RejectWasteRequest extends VersionedWriteDto {
  @ApiPropertyOptional({
    description: 'Why, for the history; the demo asks for none.',
    maxLength: WASTE_NOTE_MAX_LENGTH,
  })
  @OptionalText('reason', WASTE_NOTE_MAX_LENGTH)
  reason?: string;
}

/** `GET /staff/waste`. */
export class WasteQuery extends PaginationQuery {
  @ApiPropertyOptional({
    enum: StockLocation,
    enumName: 'StockLocation',
    description:
      'Managers: one location’s waste. Every other role reads its own ' +
      'location’s only, whether or not this is sent; naming another is the ' +
      'role refusal.',
  })
  @ValidateIf(isSent)
  @IsEnum(StockLocation, { message: STOCK_LOCATION_MESSAGE })
  location?: StockLocation;

  @ApiPropertyOptional({
    enum: WASTE_VIEWS,
    enumName: 'WasteView',
    description:
      'PENDING: awaiting review. HISTORY: approved or rejected. ALL (the ' +
      'default): both.',
  })
  @ValidateIf(isSent)
  @IsIn(WASTE_VIEWS, { message: WASTE_VIEW_MESSAGE })
  view?: WasteView;

  @ApiPropertyOptional({
    description: 'Part of a waste number, an item name or the note, any case.',
  })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: 'q must be text.' })
  @MaxLength(120, { message: 'q must be 120 characters or fewer.' })
  q?: string;
}
