import { ApiProperty } from '@nestjs/swagger';
import {
  Department,
  MenuCategoryKind,
  StaffRole,
  StockKind,
  TableKind,
} from '../../../generated/cnc-client';
import { MenuItemResponse } from '../../menu/dto/menu-item.response';
import { OpeningHoursResponse } from '../../settings/dto/opening-hours.dto';
import {
  BusinessResponse,
  SettingsResponse,
} from '../../settings/dto/settings.response';

export class ReferenceTableResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'B1' })
  code!: string;

  @ApiProperty({ example: 'Booth 1' })
  name!: string;

  @ApiProperty({ enum: TableKind, enumName: 'TableKind' })
  kind!: TableKind;

  @ApiProperty({ example: 4 })
  capacity!: number;

  @ApiProperty()
  active!: boolean;
}

export class ReferenceVenueResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'dining' })
  slug!: string;

  @ApiProperty({ example: 'Dining' })
  customerTitle!: string;

  @ApiProperty({ example: 'Diner' })
  staffName!: string;

  @ApiProperty({ example: 4 })
  bigParty!: number;

  @ApiProperty({ example: 1 })
  sort!: number;

  @ApiProperty({ type: ReferenceTableResponse, isArray: true })
  tables!: ReferenceTableResponse[];
}

export class ReferenceMenuCategoryResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'the-grill' })
  slug!: string;

  @ApiProperty({ example: 'The Grill' })
  title!: string;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ enum: MenuCategoryKind, enumName: 'MenuCategoryKind' })
  kind!: MenuCategoryKind;

  @ApiProperty({ example: 3 })
  sort!: number;
}

export class ReferenceStaffCategoryResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'Pizza' })
  name!: string;

  @ApiProperty({ enum: Department, enumName: 'Department' })
  department!: Department;

  @ApiProperty()
  menuCategoryId!: string;
}

export class ReferenceStockItemResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'Chapman' })
  name!: string;

  @ApiProperty({ enum: StockKind, enumName: 'StockKind' })
  kind!: StockKind;

  @ApiProperty({ description: 'Used As.', example: 'serving' })
  unit!: string;

  @ApiProperty({ description: 'Bought As.', example: 'batch' })
  pack!: string;

  @ApiProperty({ description: 'How Many in One.', example: 12 })
  factor!: number;

  @ApiProperty({ description: 'Reorder Level, in usage units.', example: 12 })
  minimum!: number;

  @ApiProperty({
    description: 'The paired Bar menu item; null for a Kitchen item.',
    type: String,
    nullable: true,
  })
  menuItemId!: string | null;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({ example: 0 })
  version!: number;
}

/** A colleague, as every screen may name them: no email, no photo. */
export class ReferenceStaffResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'CNC-S004' })
  staffNo!: string;

  @ApiProperty({ example: 'Grace James' })
  name!: string;

  @ApiProperty({ enum: StaffRole, enumName: 'StaffRole' })
  role!: StaffRole;

  @ApiProperty()
  isActive!: boolean;
}

/** One expected portion in a kitchen comparison rule. */
export class ReferenceKitchenMappingLineResponse {
  @ApiProperty({ description: 'StockItem.id of a Kitchen item.' })
  stockItemId!: string;

  @ApiProperty({ example: 1 })
  qty!: number;
}

/** A Restaurant dish's comparison rule (the demo's `mappings[itemId]`). */
export class ReferenceKitchenMappingResponse {
  @ApiProperty()
  menuItemId!: string;

  @ApiProperty({ type: ReferenceKitchenMappingLineResponse, isArray: true })
  lines!: ReferenceKitchenMappingLineResponse[];
}

/**
 * `GET /staff/reference`: what every screen looks things up in (plan §5.3),
 * read once when the shell loads.
 *
 * Vendors and assets join this response with the cards that build their
 * tables (C5).
 */
export class ReferenceResponse {
  @ApiProperty({ type: SettingsResponse })
  settings!: SettingsResponse;

  @ApiProperty({ type: BusinessResponse })
  business!: BusinessResponse;

  @ApiProperty({ type: OpeningHoursResponse })
  openingHours!: OpeningHoursResponse;

  @ApiProperty({ type: ReferenceVenueResponse, isArray: true })
  venues!: ReferenceVenueResponse[];

  @ApiProperty({ type: ReferenceMenuCategoryResponse, isArray: true })
  menuCategories!: ReferenceMenuCategoryResponse[];

  @ApiProperty({ type: ReferenceStaffCategoryResponse, isArray: true })
  staffCategories!: ReferenceStaffCategoryResponse[];

  @ApiProperty({
    description: 'Every menu item, available or not, in menu order.',
    type: MenuItemResponse,
    isArray: true,
  })
  menu!: MenuItemResponse[];

  @ApiProperty({ type: ReferenceStockItemResponse, isArray: true })
  stockItems!: ReferenceStockItemResponse[];

  @ApiProperty({
    description:
      'The kitchen comparison rules (C4), one per dish that has one, in ' +
      'menu order.',
    type: ReferenceKitchenMappingResponse,
    isArray: true,
  })
  kitchenMappings!: ReferenceKitchenMappingResponse[];

  @ApiProperty({
    description: 'Every staff account, active or not, by name.',
    type: ReferenceStaffResponse,
    isArray: true,
  })
  staff!: ReferenceStaffResponse[];
}
