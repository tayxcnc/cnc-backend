import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, ValidateIf } from 'class-validator';
import { StockLocation } from '../../../generated/cnc-client';
import { AdminReason, REASON_MAX_LENGTH } from '../../common/admin-reason';
import { Checked, requiredText, wholeNumber } from '../../common/checked';
import {
  LINES_DUPLICATE_MESSAGE,
  ValidLines,
} from '../../common/command-lines';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { trimText } from '../../common/trim-text';
import {
  ADJUST_DIRECTION_MESSAGE,
  COUNT_EMPTY_MESSAGE,
  COUNT_WHOLE_MESSAGE,
  ISSUE_ITEM_MESSAGE,
  ISSUE_LOCATION_MESSAGE,
  ITEM_CONVERSION_MESSAGE,
  ITEM_NAME_UNITS_MESSAGE,
  ITEM_UNITS_MESSAGE,
  LOCATION_ITEM_MESSAGE,
  STOCK_ITEM_NOT_FOUND_MESSAGE,
  STOCK_LOCATION_MESSAGE,
  STOCK_NOTE_MAX_LENGTH,
  STOCK_TEXT_MAX_LENGTH,
  WHOLE_ABOVE_ZERO_MESSAGE,
} from '../stock-messages';

/**
 * Each field answers one sentence at most (`Checked`): the staff app joins
 * every message of a 400 into what the screen shows, and the demo's
 * sentence must show once, as it stands (A7).
 */

/** The two destinations a direct issue may send to. */
export const ISSUE_DESTINATIONS = [
  StockLocation.KITCHEN,
  StockLocation.BAR,
] as const;

/** A stock item id, refused with the command's own sentence. */
const StockItemId = (message: string) =>
  Checked(requiredText(message, 64, message));

/** Optional free text: absent, or text of at most `max` characters. */
function OptionalText(name: string, max: number): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }) => trimText(value)),
    ValidateIf(isSent),
    Checked((value) => {
      if (typeof value !== 'string') return `${name} must be text.`;

      return value.length > max
        ? `${name} must be ${max} characters or fewer.`
        : null;
    }),
  );
}

/** Body of `POST /staff/stock/issues`: `stock.issue`, the Storekeeper's direct issue. */
export class StockIssueRequest {
  @ApiProperty({
    enum: ISSUE_DESTINATIONS,
    enumName: 'StockIssueDestination',
    description: 'Where the stock goes: the Kitchen or the Bar.',
  })
  @IsIn(ISSUE_DESTINATIONS, { message: ISSUE_LOCATION_MESSAGE })
  location!: (typeof ISSUE_DESTINATIONS)[number];

  @ApiProperty({
    description:
      'StockItem.id: a Kitchen item for the Kitchen, a Bar item for the Bar.',
  })
  @StockItemId(ISSUE_ITEM_MESSAGE)
  stockItemId!: string;

  @ApiProperty({
    description:
      'Whole packs taken from the Store. The destination receives packs × ' +
      'the item’s "How Many in One".',
    example: 1,
    minimum: 1,
  })
  @Checked(wholeNumber(1, WHOLE_ABOVE_ZERO_MESSAGE))
  qty!: number;

  @ApiPropertyOptional({
    description:
      'Shown as the movements’ reference; "Direct issue" when blank.',
    maxLength: STOCK_NOTE_MAX_LENGTH,
    example: 'Evening rush',
  })
  @OptionalText('note', STOCK_NOTE_MAX_LENGTH)
  note?: string;
}

/** One counted figure in a stock count. */
export class StockCountLineRequest {
  @ApiProperty({ description: 'StockItem.id.' })
  stockItemId!: string;

  @ApiProperty({
    description: 'What was counted: whole packs at the Store, units elsewhere.',
    minimum: 0,
    example: 12,
  })
  counted!: number;
}

/** Body of `POST /staff/stock/counts`: `stock.count`. */
export class StockCountRequest {
  @ApiProperty({ enum: StockLocation, enumName: 'StockLocation' })
  @IsEnum(StockLocation, { message: STOCK_LOCATION_MESSAGE })
  location!: StockLocation;

  @ApiProperty({
    type: StockCountLineRequest,
    isArray: true,
    description:
      'The counted figures, one per item. Only differences from the ' +
      'recorded balance are written. "' +
      LINES_DUPLICATE_MESSAGE +
      '" for an item named twice.',
  })
  @ValidLines({
    idKey: 'stockItemId',
    idMessage: STOCK_ITEM_NOT_FOUND_MESSAGE,
    qtyKey: 'counted',
    minQty: 0,
    qtyMessage: COUNT_WHOLE_MESSAGE,
    emptyMessage: COUNT_EMPTY_MESSAGE,
  })
  counts!: StockCountLineRequest[];

  @ApiPropertyOptional({
    description: 'Shown as the movements’ reference; "Stock count" when blank.',
    maxLength: REASON_MAX_LENGTH,
  })
  @OptionalText('reason', REASON_MAX_LENGTH)
  reason?: string;
}

/** Which way a balance correction goes. */
export enum StockAdjustDirection {
  ADD = 'ADD',
  REMOVE = 'REMOVE',
}

/** Body of `POST /staff/stock/adjustments`: `stock.adjust` (Correct Balance), the Owner only. */
export class StockAdjustRequest {
  @ApiProperty({ enum: StockLocation, enumName: 'StockLocation' })
  @IsEnum(StockLocation, { message: STOCK_LOCATION_MESSAGE })
  location!: StockLocation;

  @ApiProperty({ description: 'StockItem.id, an item this location holds.' })
  @StockItemId(LOCATION_ITEM_MESSAGE)
  stockItemId!: string;

  @ApiProperty({
    enum: StockAdjustDirection,
    enumName: 'StockAdjustDirection',
  })
  @IsEnum(StockAdjustDirection, { message: ADJUST_DIRECTION_MESSAGE })
  direction!: StockAdjustDirection;

  @ApiProperty({ minimum: 1, example: 1 })
  @Checked(wholeNumber(1, WHOLE_ABOVE_ZERO_MESSAGE))
  qty!: number;

  @AdminReason(
    'Why the balance is corrected. Shown as the movement’s reference.',
  )
  reason!: string;
}

/** The text fields of a stock item, trimmed and required. */
function StockText(message: string, example: string): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ example, maxLength: STOCK_TEXT_MAX_LENGTH }),
    Transform(({ value }) => trimText(value)),
    Checked(
      requiredText(
        message,
        STOCK_TEXT_MAX_LENGTH,
        `Stock item names and units must be ${STOCK_TEXT_MAX_LENGTH} characters or fewer.`,
      ),
    ),
  );
}

/** A whole number of `min` or more, refused with `message`. */
function WholeNumber(
  min: 0 | 1,
  message: string,
  description: string,
): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ description, minimum: min, example: min === 1 ? 10 : 5 }),
    Checked(wholeNumber(min, message)),
  );
}

/** Body of `POST /staff/stock/items`: `stockitem.create`, a new Kitchen item. */
export class CreateStockItemRequest {
  @StockText(ITEM_NAME_UNITS_MESSAGE, 'Jollof Rice')
  name!: string;

  @StockText(ITEM_NAME_UNITS_MESSAGE, 'portion')
  unit!: string;

  @StockText(ITEM_NAME_UNITS_MESSAGE, 'tray')
  pack!: string;

  @WholeNumber(1, ITEM_CONVERSION_MESSAGE, 'How Many in One: units per pack.')
  factor!: number;

  @WholeNumber(0, ITEM_CONVERSION_MESSAGE, 'Reorder Level, in units.')
  minimum!: number;
}

/** Body of `PATCH /staff/stock/items/:id`: `stockitem.save` (Units). */
export class UpdateStockItemRequest extends VersionedWriteDto {
  @StockText(ITEM_UNITS_MESSAGE, 'portion')
  unit!: string;

  @StockText(ITEM_UNITS_MESSAGE, 'tray')
  pack!: string;

  @WholeNumber(
    1,
    ITEM_UNITS_MESSAGE,
    'How Many in One. Balances are not rescaled (D40): the Store keeps its packs.',
  )
  factor!: number;

  @WholeNumber(0, ITEM_UNITS_MESSAGE, 'Reorder Level, in units.')
  minimum!: number;

  @AdminReason('Why the units changed.')
  reason!: string;
}
