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
  StockRequestStatus,
} from '../../../generated/cnc-client';
import { REASON_MAX_LENGTH } from '../../common/admin-reason';
import { Checked, requiredText, wholeNumber } from '../../common/checked';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { OptionalText } from '../../common/optional-text';
import { trimText } from '../../common/trim-text';
import { REQUEST_LOCATIONS } from '../stock-request-rules';
import {
  ISSUE_ITEM_MESSAGE,
  ISSUE_LOCATION_MESSAGE,
  REJECT_REASON_MESSAGE,
  REQUEST_QTY_MESSAGE,
  REQUEST_STATUS_FILTER_MESSAGE,
  STOCK_NOTE_MAX_LENGTH,
} from '../stock-messages';

/**
 * Each field answers one sentence at most (`Checked`): the staff app joins
 * every message of a 400 into what the screen shows, and the demo's
 * sentence must show once, as it stands (A7).
 */

/** Body of `POST /staff/stock/requests`: `request.create`. */
export class CreateStockRequestRequest {
  @ApiPropertyOptional({
    enum: StockLocation,
    enumName: 'StockLocation',
    description:
      'Managers choose the Kitchen or the Bar. A Kitchen user’s request is ' +
      'always for the Kitchen and a Bartender’s or Cashier’s for the Bar, ' +
      'whatever is sent here, as in the staff app.',
  })
  @ValidateIf(isSent)
  @IsEnum(StockLocation, { message: ISSUE_LOCATION_MESSAGE })
  location?: StockLocation;

  @ApiProperty({
    description:
      'StockItem.id: a Kitchen item for the Kitchen, a Bar item for the Bar.',
  })
  @Checked(requiredText(ISSUE_ITEM_MESSAGE, 64, ISSUE_ITEM_MESSAGE))
  stockItemId!: string;

  @ApiProperty({
    description:
      'Whole packs ("Bought As") asked of the Store. The location receives ' +
      'packs × the item’s "How Many in One" when they are issued.',
    minimum: 1,
    example: 2,
  })
  @Checked(wholeNumber(1, REQUEST_QTY_MESSAGE))
  qty!: number;

  @ApiPropertyOptional({
    description: 'Shown with the request, for the Storekeeper.',
    maxLength: STOCK_NOTE_MAX_LENGTH,
    example: 'Dinner preparation',
  })
  @OptionalText('note', STOCK_NOTE_MAX_LENGTH)
  note?: string;
}

/** Body of `POST /staff/stock/requests/:id/issue`: `request.issue`. */
export class IssueStockRequestRequest extends VersionedWriteDto {
  @ApiProperty({
    description:
      'Whole packs sent now, no more than the request still wants. The ' +
      'Store loses the packs and the request’s location gains packs × How ' +
      'Many in One. A bad figure is refused with "Enter a whole number of ' +
      '<pack>s within the remaining request.", which names the item’s pack ' +
      'and so is checked against the stored request, not here.',
    minimum: 1,
    example: 1,
  })
  @Allow()
  qty!: unknown;
}

/** Body of `POST /staff/stock/requests/:id/reject`: `request.reject`. */
export class RejectStockRequestRequest extends VersionedWriteDto {
  @ApiProperty({
    description: 'Why the Store declines what is left of the request.',
    maxLength: REASON_MAX_LENGTH,
    example: 'Out until Friday’s delivery',
  })
  @Transform(({ value }) => trimText(value))
  @Checked(
    requiredText(
      REJECT_REASON_MESSAGE,
      REASON_MAX_LENGTH,
      `reason must be ${REASON_MAX_LENGTH} characters or fewer.`,
    ),
  )
  reason!: string;
}

/** `GET /staff/stock/requests`. */
export class StockRequestsQuery extends PaginationQuery {
  @ApiPropertyOptional({
    enum: REQUEST_LOCATIONS,
    enumName: 'StockRequestLocation',
    description:
      'The Kitchen’s or the Bar’s requests. A Kitchen user reads the ' +
      'Kitchen’s only and a Bartender the Bar’s only, whether or not this ' +
      'is sent; the Storekeeper and managers read both when it is absent.',
  })
  @ValidateIf(isSent)
  @IsIn(REQUEST_LOCATIONS, { message: ISSUE_LOCATION_MESSAGE })
  location?: (typeof REQUEST_LOCATIONS)[number];

  @ApiPropertyOptional({
    enum: StockRequestStatus,
    enumName: 'StockRequestStatus',
  })
  @ValidateIf(isSent)
  @IsEnum(StockRequestStatus, { message: REQUEST_STATUS_FILTER_MESSAGE })
  status?: StockRequestStatus;

  @ApiPropertyOptional({
    description: 'Part of a request number or an item name, any case.',
  })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: 'q must be text.' })
  @MaxLength(120, { message: 'q must be 120 characters or fewer.' })
  q?: string;
}
