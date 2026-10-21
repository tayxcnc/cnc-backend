import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsString, MaxLength, ValidateIf } from 'class-validator';
import {
  StockKind,
  StockLocation,
  StockMovementType,
} from '../../../generated/cnc-client';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { isSent } from '../../common/is-sent';
import { trimText } from '../../common/trim-text';
import { STOCK_LOCATION_MESSAGE } from '../stock-messages';

/** A stock item as the stock routes answer it. */
export class StockItemResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Jollof Rice' }) name!: string;
  @ApiProperty({ enum: StockKind, enumName: 'StockKind' }) kind!: StockKind;
  @ApiProperty({ description: 'Used As.', example: 'portion' }) unit!: string;
  @ApiProperty({ description: 'Bought As.', example: 'tray' }) pack!: string;
  @ApiProperty({ description: 'How Many in One.', example: 10 })
  factor!: number;
  @ApiProperty({ description: 'Reorder Level, in units.', example: 15 })
  minimum!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The paired menu item, for a Bar item.',
  })
  menuItemId!: string | null;
  @ApiProperty() active!: boolean;
  @ApiProperty({ example: 0 }) version!: number;
}

/** `GET /staff/stock/balances`: who asks, for which location. */
export class StockBalancesQuery extends PaginationQuery {
  @ApiProperty({
    enum: StockLocation,
    enumName: 'StockLocation',
    description:
      'Required. A Bartender reads the Bar only, a Kitchen user the ' +
      'Kitchen only; the Storekeeper and managers read any location.',
  })
  @IsEnum(StockLocation, { message: STOCK_LOCATION_MESSAGE })
  location!: StockLocation;

  @ApiPropertyOptional({ description: 'Part of an item name, any case.' })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: 'q must be text.' })
  @MaxLength(120, { message: 'q must be 120 characters or fewer.' })
  q?: string;
}

/** One item's balance at the asked location. */
export class StockBalanceResponse {
  @ApiProperty() stockItemId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: StockKind, enumName: 'StockKind' }) kind!: StockKind;
  @ApiProperty({ enum: StockLocation, enumName: 'StockLocation' })
  location!: StockLocation;
  @ApiProperty({
    description:
      'Whole packs at the Store, units elsewhere. Below zero only at the ' +
      'Bar, after a paid web order took drinks the Bar did not hold.',
  })
  qty!: number;
  @ApiProperty() unit!: string;
  @ApiProperty() pack!: string;
  @ApiProperty() factor!: number;
  @ApiProperty() minimum!: number;
  @ApiProperty({
    description:
      'Low Stock: the Store is out, or the Kitchen or Bar is below the ' +
      'reorder level.',
  })
  low!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'At the Bar: the drinks on Open or Payment Bar bills, not yet ' +
      'deducted (they are deducted at settlement). Null elsewhere.',
  })
  pendingQty!: number | null;
  @ApiProperty() active!: boolean;
  @ApiProperty({ description: 'The stock item’s version, for a Units change.' })
  version!: number;
}

export class StockBalancePageResponse {
  @ApiProperty({ type: StockBalanceResponse, isArray: true })
  data!: StockBalanceResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

/** `GET /staff/stock/movements`. */
export class StockMovementsQuery extends PaginationQuery {
  @ApiPropertyOptional({ enum: StockLocation, enumName: 'StockLocation' })
  @ValidateIf(isSent)
  @IsEnum(StockLocation, { message: STOCK_LOCATION_MESSAGE })
  location?: StockLocation;

  @ApiPropertyOptional({ description: 'One stock item’s movements.' })
  @ValidateIf(isSent)
  @IsString({ message: 'stockItemId must be text.' })
  stockItemId?: string;

  @ApiPropertyOptional({ description: 'Part of an item name, any case.' })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: 'q must be text.' })
  @MaxLength(120, { message: 'q must be 120 characters or fewer.' })
  q?: string;
}

/** One movement, newest first. */
export class StockMovementResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ description: 'When it happened (ISO 8601, UTC).' })
  at!: string;
  @ApiProperty() stockItemId!: string;
  @ApiProperty() stockItemName!: string;
  @ApiProperty({ enum: StockLocation, enumName: 'StockLocation' })
  location!: StockLocation;
  @ApiProperty({ description: 'Signed: negative is stock leaving.' })
  qty!: number;
  @ApiProperty({ enum: StockMovementType, enumName: 'StockMovementType' })
  type!: StockMovementType;
  @ApiProperty({ description: 'An order number, a docket ref, a note.' })
  ref!: string;
  @ApiProperty({ type: String, nullable: true }) staffId!: string | null;
  @ApiProperty({ type: String, nullable: true }) staffName!: string | null;
}

export class StockMovementPageResponse {
  @ApiProperty({ type: StockMovementResponse, isArray: true })
  data!: StockMovementResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}

/** What a direct issue moved, and the two balances after it. */
export class StockIssueResponse {
  @ApiProperty() stockItemId!: string;
  @ApiProperty({ enum: [StockLocation.KITCHEN, StockLocation.BAR] })
  location!: StockLocation;
  @ApiProperty({ description: 'Packs taken from the Store.' })
  packs!: number;
  @ApiProperty({ description: 'Units received at the destination.' })
  units!: number;
  @ApiProperty({ description: 'The Store balance after the issue, in packs.' })
  storeQty!: number;
  @ApiProperty({ description: 'The destination balance after it, in units.' })
  destinationQty!: number;
}

/** One difference a stock count recorded. */
export class StockCountChangeResponse {
  @ApiProperty() stockItemId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() recorded!: number;
  @ApiProperty() counted!: number;
  @ApiProperty({ description: 'counted − recorded; never zero.' })
  difference!: number;
}

export class StockCountResponse {
  @ApiProperty({ enum: StockLocation, enumName: 'StockLocation' })
  location!: StockLocation;
  @ApiProperty({
    type: StockCountChangeResponse,
    isArray: true,
    description: 'Only the items whose count differed; empty when none did.',
  })
  changes!: StockCountChangeResponse[];
}

export class StockAdjustResponse {
  @ApiProperty() stockItemId!: string;
  @ApiProperty({ enum: StockLocation, enumName: 'StockLocation' })
  location!: StockLocation;
  @ApiProperty({ description: 'The signed change: negative for Remove.' })
  qty!: number;
  @ApiProperty({ description: 'The balance after the correction.' })
  balance!: number;
}
