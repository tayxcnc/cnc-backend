import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  Matches,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { ISO_DATE } from '../../common/calendar-date';
import {
  OVERVIEW_PERIODS,
  OVERVIEW_WIDGETS,
  type OverviewPeriod,
  type OverviewWidgetId,
  validDate,
} from '../overview-preferences';

/** One widget's place in the layout. */
export class OverviewWidgetDto {
  @ApiProperty({ enum: OVERVIEW_WIDGETS, example: 'sales' })
  @IsIn(OVERVIEW_WIDGETS, { message: 'Choose a known overview widget.' })
  id!: OverviewWidgetId;

  @ApiProperty({ example: true })
  @IsBoolean({ message: 'visible must be true or false.' })
  visible!: boolean;

  @ApiProperty({ example: false })
  @IsBoolean({ message: 'wide must be true or false.' })
  wide!: boolean;
}

/** Each widget once, and at least one of them shown. */
@ValidatorConstraint({ name: 'overviewWidgets', async: false })
export class UsableOverviewWidgets implements ValidatorConstraintInterface {
  validate(widgets: unknown): boolean {
    if (!Array.isArray(widgets)) return true; // IsArray reports it

    const items = widgets as Partial<OverviewWidgetDto>[];
    const ids = items.map((widget) => widget?.id);

    return (
      new Set(ids).size === ids.length &&
      items.some((widget) => widget?.visible === true)
    );
  }

  defaultMessage(): string {
    return 'Name each widget at most once, and show at least one.';
  }
}

/** A real `YYYY-MM-DD` day, not 2026-02-30. */
@ValidatorConstraint({ name: 'realDate', async: false })
export class RealDate implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return validDate(value);
  }

  defaultMessage(): string {
    return 'from and to must be real dates in YYYY-MM-DD form.';
  }
}

/**
 * The manager overview's layout (`PUT` body and both answers), in the staff
 * app's own shape (`lib/overview.ts`, `OverviewPreferences`).
 *
 * `version` is the layout format's version and is always 1. It is not the
 * record version of plan A8: a person's own layout is theirs alone, and the
 * last save wins.
 */
export class OverviewPreferencesDto {
  @ApiProperty({
    description: 'The layout format: always 1.',
    enum: [1],
    example: 1,
  })
  @IsIn([1], { message: 'version must be 1.' })
  version!: 1;

  @ApiProperty({
    description:
      'The widgets in display order. A widget left out is added, hidden.',
    type: OverviewWidgetDto,
    isArray: true,
  })
  @IsArray({ message: 'widgets must be a list.' })
  @ArrayMinSize(1, { message: 'Show at least one widget.' })
  @ArrayMaxSize(OVERVIEW_WIDGETS.length, {
    message: 'Name each widget at most once, and show at least one.',
  })
  @ValidateNested({ each: true })
  @Type(() => OverviewWidgetDto)
  @Validate(UsableOverviewWidgets)
  widgets!: OverviewWidgetDto[];

  @ApiProperty({ enum: OVERVIEW_PERIODS, example: 'Today' })
  @IsIn(OVERVIEW_PERIODS, { message: 'Choose a known period.' })
  period!: OverviewPeriod;

  @ApiProperty({
    description: 'The custom period’s first day (WAT), YYYY-MM-DD.',
    example: '2026-10-21',
  })
  @Matches(ISO_DATE, {
    message: 'from and to must be real dates in YYYY-MM-DD form.',
  })
  @Validate(RealDate)
  from!: string;

  @ApiProperty({
    description: 'The custom period’s last day (WAT), YYYY-MM-DD.',
    example: '2026-10-21',
  })
  @Matches(ISO_DATE, {
    message: 'from and to must be real dates in YYYY-MM-DD form.',
  })
  @Validate(RealDate)
  to!: string;
}
