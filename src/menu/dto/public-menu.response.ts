import { ApiProperty } from '@nestjs/swagger';
import { MenuCategoryKind } from '../../../generated/cnc-client';

/** A dish's choice, as the website asks it ("Protein": Chicken, Beef). */
export class PublicMenuChoiceResponse {
  @ApiProperty({ example: 'Protein' })
  label!: string;

  @ApiProperty({ type: String, isArray: true, example: ['Chicken', 'Beef'] })
  options!: string[];
}

/**
 * A dish or a drink as the website and the order page show it. Only what a
 * guest sees: no row id, version, staff category, stock or availability
 * switches.
 */
export class PublicMenuItemResponse {
  @ApiProperty({
    description: 'Permanent and never reused; a cart line names it.',
    example: 'masa-and-suya',
  })
  slug!: string;

  @ApiProperty({ example: 'Masa & Suya' })
  name!: string;

  @ApiProperty({ example: 'Northern rice cakes griddled to order' })
  description!: string;

  @ApiProperty({
    description: 'In kobo, before VAT.',
    example: 750000,
  })
  priceKobo!: number;

  @ApiProperty()
  signature!: boolean;

  @ApiProperty({
    description: 'The heading the dish sits under within its category.',
    type: String,
    nullable: true,
    example: 'Nigerian Heritage',
  })
  group!: string | null;

  @ApiProperty({ type: PublicMenuChoiceResponse, nullable: true })
  choice!: PublicMenuChoiceResponse | null;

  @ApiProperty({
    description:
      'A signed link to the photo (fits inside 800 pixels), or null. Valid ' +
      'for at least 45 minutes after this response: the same link is ' +
      'handed out again until then.',
    type: String,
    nullable: true,
  })
  photoUrl!: string | null;

  @ApiProperty({
    description:
      'A signed link to the photo’s thumbnail, a WebP that fits inside 240 ' +
      'pixels, for list views; valid as long as `photoUrl`. Null when ' +
      'there is no photo, and for a photo stored before thumbnails until ' +
      'its thumbnail is made: show `photoUrl` then.',
    type: String,
    nullable: true,
  })
  thumbUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  photoAlt!: string | null;
}

/** A customer category with its dishes, in menu order. */
export class PublicMenuCategoryResponse {
  @ApiProperty({ example: 'breakfast' })
  slug!: string;

  @ApiProperty({ example: 'Breakfast' })
  title!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Served through the morning',
  })
  note!: string | null;

  @ApiProperty({ enum: MenuCategoryKind, enumName: 'MenuCategoryKind' })
  kind!: MenuCategoryKind;

  @ApiProperty({ type: PublicMenuItemResponse, isArray: true })
  items!: PublicMenuItemResponse[];
}

/** `GET /menu`. */
export class PublicMenuResponse {
  @ApiProperty({
    type: PublicMenuCategoryResponse,
    isArray: true,
    description:
      'Categories in menu order; a category with no dish shown is left out.',
  })
  categories!: PublicMenuCategoryResponse[];
}
