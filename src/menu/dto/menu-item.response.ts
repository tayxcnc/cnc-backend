import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Department } from '../../../generated/cnc-client';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { trimText } from '../../common/trim-text';

/** A dish or a drink as Menu & Prices shows it (plan §4.1, §5.4). */
export class MenuItemResponse {
  @ApiProperty({ example: 'clx8k2p9r0000v8n4h1q2w3e4' })
  id!: string;

  @ApiProperty({
    description: 'Permanent and never reused; the website and carts name it.',
    example: 'zobo-spritz',
  })
  slug!: string;

  @ApiProperty({
    description: 'The staff demo’s id (`bar-3`), for seeded items only.',
    type: String,
    nullable: true,
  })
  legacyStaffId!: string | null;

  @ApiProperty({ enum: Department, enumName: 'Department' })
  department!: Department;

  @ApiProperty()
  staffCategoryId!: string;

  @ApiProperty({ example: 'Mocktails' })
  staffCategoryName!: string;

  @ApiProperty()
  menuCategoryId!: string;

  @ApiProperty({ example: 'drinks' })
  menuCategorySlug!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Monday' })
  groupLabel!: string | null;

  @ApiProperty({ example: 'Zobo Spritz' })
  name!: string;

  @ApiProperty({ example: '' })
  description!: string;

  @ApiProperty({ description: 'In kobo.', example: 350000 })
  priceKobo!: number;

  @ApiProperty()
  signature!: boolean;

  @ApiProperty({ description: 'Available for Sale.' })
  active!: boolean;

  @ApiProperty({ description: 'Show Online.' })
  showOnline!: boolean;

  @ApiProperty({
    description: 'A short-lived signed link to the photo, or null.',
    type: String,
    nullable: true,
  })
  photoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  photoAlt!: string | null;

  @ApiProperty({
    description: 'The choice’s prompt ("Protein"), or null when none.',
    type: String,
    nullable: true,
  })
  choiceLabel!: string | null;

  @ApiProperty({ type: String, isArray: true })
  choiceOptions!: string[];

  @ApiProperty({ description: 'Order within its customer category.' })
  sort!: number;

  @ApiProperty({
    description: 'The paired Bar stock item’s id; null for a Restaurant item.',
    type: String,
    nullable: true,
  })
  stockItemId!: string | null;

  @ApiProperty({ example: 2 })
  version!: number;
}

/** `GET /staff/menu`: one page of items. */
export class MenuPageResponse {
  @ApiProperty({ type: MenuItemResponse, isArray: true })
  data!: MenuItemResponse[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 100 })
  pageSize!: number;

  @ApiProperty({ example: 166 })
  total!: number;
}

/** `GET /staff/menu?department=&q=` (plan §5.4, Menu & Prices). */
export class MenuListQuery extends PaginationQuery {
  @ApiPropertyOptional({ enum: Department, enumName: 'Department' })
  @IsOptional()
  @IsEnum(Department, { message: 'department must be RESTAURANT or BAR.' })
  department?: Department;

  @ApiPropertyOptional({
    description: 'Matches part of the name, ignoring case.',
    example: 'zobo',
  })
  @IsOptional()
  @Transform(({ value }) => trimText(value))
  @IsString({ message: 'q must be text.' })
  @MaxLength(100, { message: 'q must be 100 characters or fewer.' })
  q?: string;
}
