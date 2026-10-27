import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  Max,
  Min,
  Validate,
  ValidateNested,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { DAYS_IN_WEEK, MINUTES_IN_DAY, weekRuleBroken } from '../opening-hours';

/** One day of CNC's week. */
export class OpeningHoursDayResponse {
  @ApiProperty({
    description: '0 = Sunday … 6 = Saturday, as JavaScript `getDay()` counts.',
    minimum: 0,
    maximum: 6,
    example: 1,
  })
  dayOfWeek!: number;

  @ApiProperty({ description: 'True when CNC does not open that day.' })
  isClosed!: boolean;

  @ApiProperty({
    description:
      'Opening, in WAT minutes from midnight (480 is 08:00). Null when closed.',
    type: Number,
    nullable: true,
    example: 480,
  })
  opensAtMinutes!: number | null;

  @ApiProperty({
    description:
      'Closing, in WAT minutes from midnight (1440 is midnight at the end of ' +
      'the day, the latest). Null when closed.',
    type: Number,
    nullable: true,
    example: 1440,
  })
  closesAtMinutes!: number | null;
}

/**
 * CNC's week, in TAY's response shape (D26), which the public
 * `GET /opening-hours` (C6) answers too.
 */
export class OpeningHoursResponse {
  @ApiProperty({
    description:
      'True when all seven days are stored (always, after the migration).',
  })
  isSet!: boolean;

  @ApiProperty({
    description: 'The seven days, Sunday (0) first, or null when not set.',
    type: OpeningHoursDayResponse,
    isArray: true,
    nullable: true,
  })
  days!: OpeningHoursDayResponse[] | null;

  @ApiProperty({
    description: 'When the week was last written, UTC.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  updatedAt!: Date | null;
}

/**
 * The week-level rules as a validator on `days`, so a broken week is a 400
 * from the global pipe, worded by `weekRuleBroken` (TAY's).
 */
@ValidatorConstraint({ name: 'wholeOpeningWeek', async: false })
export class WholeOpeningWeek implements ValidatorConstraintInterface {
  validate(days: unknown): boolean {
    return weekRuleBroken(days) === null;
  }

  defaultMessage(args: ValidationArguments): string {
    return weekRuleBroken(args.value) ?? 'days is not a valid week.';
  }
}

/** One day of the week being written. */
export class OpeningHoursDayRequest {
  @ApiProperty({ minimum: 0, maximum: DAYS_IN_WEEK - 1, example: 1 })
  @IsInt({ message: 'dayOfWeek must be a whole number from 0 to 6.' })
  @Min(0, { message: 'dayOfWeek must be a whole number from 0 to 6.' })
  @Max(DAYS_IN_WEEK - 1, {
    message: 'dayOfWeek must be a whole number from 0 to 6.',
  })
  dayOfWeek!: number;

  @ApiProperty({
    description: 'True when CNC does not open that day; it takes no times.',
  })
  @IsBoolean({ message: 'isClosed must be true or false.' })
  isClosed!: boolean;

  /*
   * `@IsOptional`, not `@ValidateIf(isSent)`, on both times, on purpose (as
   * in TAY): null means the day is closed, and the response carries null for
   * a closed day, so a client that sends back what it read must be accepted.
   * The week rule then requires a number on an open day and refuses one on a
   * closed day, so no null reaches the service unchecked.
   */
  @ApiPropertyOptional({
    description: 'Required on an open day; absent or null on a closed day.',
    minimum: 0,
    maximum: MINUTES_IN_DAY,
    nullable: true,
    type: Number,
    example: 480,
  })
  @IsOptional()
  @IsInt({ message: 'opensAtMinutes must be a whole number of minutes.' })
  @Min(0, { message: 'opensAtMinutes must be from 0 to 1440.' })
  @Max(MINUTES_IN_DAY, { message: 'opensAtMinutes must be from 0 to 1440.' })
  opensAtMinutes?: number | null;

  @ApiPropertyOptional({
    description:
      'Later than `opensAtMinutes`, at most 1440. Required on an open day; ' +
      'absent or null on a closed day.',
    minimum: 0,
    maximum: MINUTES_IN_DAY,
    nullable: true,
    type: Number,
    example: 1440,
  })
  @IsOptional()
  @IsInt({ message: 'closesAtMinutes must be a whole number of minutes.' })
  @Min(0, { message: 'closesAtMinutes must be from 0 to 1440.' })
  @Max(MINUTES_IN_DAY, { message: 'closesAtMinutes must be from 0 to 1440.' })
  closesAtMinutes?: number | null;
}

/**
 * Body of `PUT /api/v1/staff/opening-hours`: the whole week, which replaces
 * the stored one. A PUT of seven days rather than a PATCH of one, because
 * the week is the resource: a day-by-day write leaves a window in which a
 * reader sees half of one week and half of another.
 */
export class ReplaceOpeningHoursRequest {
  @ApiProperty({
    description:
      'Exactly seven days, each `dayOfWeek` 0 to 6 once, in any order.',
    type: OpeningHoursDayRequest,
    isArray: true,
    minItems: DAYS_IN_WEEK,
    maxItems: DAYS_IN_WEEK,
  })
  @IsArray({ message: 'days must be a list of the seven days.' })
  @ValidateNested({ each: true })
  @Type(() => OpeningHoursDayRequest)
  @Validate(WholeOpeningWeek)
  days!: OpeningHoursDayRequest[];
}
