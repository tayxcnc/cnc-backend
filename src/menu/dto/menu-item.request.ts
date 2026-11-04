import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { Department } from '../../../generated/cnc-client';
import { Checked, requiredText, textUpTo } from '../../common/checked';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { noLongDashes } from '../../common/no-long-dashes';
import { trimText } from '../../common/trim-text';
import { INT4_MAX } from '../../prisma/int4';
import {
  MENU_CATEGORY_MESSAGE,
  MENU_DEPARTMENT_MESSAGE,
  MENU_DESCRIPTION_MAX_LENGTH,
  MENU_NAME_MAX_LENGTH,
  MENU_NAME_PRICE_MESSAGE,
  MENU_PHOTO_ALT_MAX_LENGTH,
} from '../menu-messages';

/*
 * The three text fields a guest reads on the website and the menu: each
 * answers one sentence (`Checked`), its own as before, then "Please rewrite
 * this without long dashes." for a long dash (G2, decision P18). Shared by
 * the create and the change, so the two cannot drift apart.
 */

/** The name: required, at most {@link MENU_NAME_MAX_LENGTH} characters. */
const NAME_PROBLEM = noLongDashes(
  requiredText(
    MENU_NAME_PRICE_MESSAGE,
    MENU_NAME_MAX_LENGTH,
    `An item name must be ${MENU_NAME_MAX_LENGTH} characters or fewer.`,
  ),
);

/** The description, when sent: text, possibly empty. */
const DESCRIPTION_PROBLEM = noLongDashes(
  textUpTo(
    'description must be text.',
    MENU_DESCRIPTION_MAX_LENGTH,
    `A description must be ${MENU_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
  ),
);

/** The photo's alternative text, when sent and not null. */
const PHOTO_ALT_PROBLEM = noLongDashes(
  textUpTo(
    'photoAlt must be text.',
    MENU_PHOTO_ALT_MAX_LENGTH,
    `photoAlt must be ${MENU_PHOTO_ALT_MAX_LENGTH} characters or fewer.`,
  ),
);

/**
 * Body of `POST /api/v1/staff/menu`: `menu.save` adding a dish or a drink.
 * The Owner only, because every item needs a price.
 *
 * The slug is made from the name and is never reused; the customer category
 * follows the staff category; a new item has no choice or group heading
 * (those are seed-managed). A Bar item gets its paired Bar stock item in
 * the same transaction.
 */
export class CreateMenuItemRequest {
  @ApiProperty({ example: 'Zobo Spritz', maxLength: MENU_NAME_MAX_LENGTH })
  @Transform(({ value }) => trimText(value))
  @Checked(NAME_PROBLEM)
  name!: string;

  @ApiProperty({
    description: 'In kobo, a whole number above zero.',
    example: 350000,
  })
  @IsInt({ message: MENU_NAME_PRICE_MESSAGE })
  @Min(1, { message: MENU_NAME_PRICE_MESSAGE })
  @Max(INT4_MAX, { message: MENU_NAME_PRICE_MESSAGE })
  priceKobo!: number;

  @ApiProperty({ enum: Department, enumName: 'Department' })
  @IsEnum(Department, { message: MENU_DEPARTMENT_MESSAGE })
  department!: Department;

  @ApiProperty({
    description:
      'StaffCategory.id ("Pizza", "Tea Corner (Hot)"), from the same ' +
      'department. The customer category follows from it.',
    example: 'clx8k2p9r0000v8n4h1q2w3e4',
  })
  @IsString({ message: MENU_CATEGORY_MESSAGE })
  @IsNotEmpty({ message: MENU_CATEGORY_MESSAGE })
  staffCategoryId!: string;

  @ApiPropertyOptional({
    description: 'Shown on the website. Defaults to blank.',
    maxLength: MENU_DESCRIPTION_MAX_LENGTH,
  })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @Checked(DESCRIPTION_PROBLEM)
  description?: string;

  @ApiPropertyOptional({
    description: 'Available for Sale. Defaults to true.',
    example: true,
  })
  @ValidateIf(isSent)
  @IsBoolean({ message: 'active must be true or false.' })
  active?: boolean;

  @ApiPropertyOptional({
    description: 'Show Online: whether the website lists it. Defaults to true.',
    example: true,
  })
  @ValidateIf(isSent)
  @IsBoolean({ message: 'showOnline must be true or false.' })
  showOnline?: boolean;

  @ApiPropertyOptional({
    description:
      'Text describing the photo, for screen readers; null for none.',
    type: String,
    nullable: true,
    maxLength: MENU_PHOTO_ALT_MAX_LENGTH,
  })
  @Transform(({ value }) => trimText(value))
  @IsOptional()
  @Checked(PHOTO_ALT_PROBLEM)
  photoAlt?: string | null;
}

/**
 * Body of `PATCH /api/v1/staff/menu/:id`: `menu.save` changing an item.
 * Managers may; only the Owner may change the price ("Only the Owner can
 * change a price."). A field left out is unchanged, so a manager may send
 * the current price with the rest of the form. The department, the slug,
 * the choice and the group heading do not change here.
 */
export class UpdateMenuItemRequest extends VersionedWriteDto {
  @ApiPropertyOptional({
    example: 'Zobo Spritz',
    maxLength: MENU_NAME_MAX_LENGTH,
  })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @Checked(NAME_PROBLEM)
  name?: string;

  @ApiPropertyOptional({
    description:
      'In kobo, a whole number above zero. A change is the Owner’s; it ' +
      'applies to new order lines only.',
    example: 350000,
  })
  @ValidateIf(isSent)
  @IsInt({ message: MENU_NAME_PRICE_MESSAGE })
  @Min(1, { message: MENU_NAME_PRICE_MESSAGE })
  @Max(INT4_MAX, { message: MENU_NAME_PRICE_MESSAGE })
  priceKobo?: number;

  @ApiPropertyOptional({
    description: 'StaffCategory.id, from the item’s own department.',
  })
  @ValidateIf(isSent)
  @IsString({ message: MENU_CATEGORY_MESSAGE })
  @IsNotEmpty({ message: MENU_CATEGORY_MESSAGE })
  staffCategoryId?: string;

  @ApiPropertyOptional({ maxLength: MENU_DESCRIPTION_MAX_LENGTH })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @Checked(DESCRIPTION_PROBLEM)
  description?: string;

  @ApiPropertyOptional({ description: 'Available for Sale.' })
  @ValidateIf(isSent)
  @IsBoolean({ message: 'active must be true or false.' })
  active?: boolean;

  @ApiPropertyOptional({ description: 'Show Online.' })
  @ValidateIf(isSent)
  @IsBoolean({ message: 'showOnline must be true or false.' })
  showOnline?: boolean;

  @ApiPropertyOptional({
    description: 'Text describing the photo; null clears it.',
    type: String,
    nullable: true,
    maxLength: MENU_PHOTO_ALT_MAX_LENGTH,
  })
  @Transform(({ value }) => trimText(value))
  @IsOptional()
  @Checked(PHOTO_ALT_PROBLEM)
  photoAlt?: string | null;
}
