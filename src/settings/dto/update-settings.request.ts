import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  Max,
  Min,
  ValidateBy,
  ValidateIf,
  type ValidationOptions,
} from 'class-validator';
import { PrinterWidth } from '../../../generated/cnc-client';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { INT4_MAX } from '../../prisma/int4';
import {
  ALERT_SWITCH_MESSAGE,
  DAILY_LIMIT_SWITCH_MESSAGE,
  PRINTER_WIDTH_MESSAGE,
  SETTINGS_NUMBERS_MESSAGE,
  SETTINGS_RANGES_MESSAGE,
  SETTINGS_TIMES_MESSAGE,
  SETTINGS_TOO_LARGE_MESSAGE,
} from '../settings-rules';

/** An optional amount in kobo: a whole number of 0 or more. */
function MoneySetting(description: string, example: number) {
  return applyDecorators(
    ApiPropertyOptional({
      description: `${description} In kobo. Owner only.`,
      minimum: 0,
      example,
    }),
    ValidateIf(isSent),
    IsInt({ message: SETTINGS_NUMBERS_MESSAGE }),
    Min(0, { message: SETTINGS_NUMBERS_MESSAGE }),
    Max(INT4_MAX, { message: SETTINGS_TOO_LARGE_MESSAGE }),
  );
}

/** An optional rate in basis points, 0 to 10,000 (100%). */
function RateSetting(description: string, example: number) {
  return applyDecorators(
    ApiPropertyOptional({
      description: `${description} In basis points: 750 is 7.5%. Owner only.`,
      minimum: 0,
      maximum: 10000,
      example,
    }),
    ValidateIf(isSent),
    IsInt({ message: SETTINGS_NUMBERS_MESSAGE }),
    Min(0, { message: SETTINGS_NUMBERS_MESSAGE }),
    Max(10000, { message: SETTINGS_RANGES_MESSAGE }),
  );
}

/** An optional booking or ordering time, in minutes. Owner only (Q29). */
function TimeSetting(description: string, min: number, example: number) {
  return applyDecorators(
    ApiPropertyOptional({
      description: `${description} Owner only (Q29).`,
      minimum: min,
      maximum: 1440,
      example,
    }),
    ValidateIf(isSent),
    IsInt({ message: SETTINGS_TIMES_MESSAGE }),
    Min(min, { message: SETTINGS_TIMES_MESSAGE }),
    Max(1440, { message: SETTINGS_TIMES_MESSAGE }),
  );
}

/**
 * At least `min`, judged only for a number of 0 or more.
 *
 * The demo checks the Free Table Reminder in two steps: first that it is a
 * whole number of 0 or more ("Settings must be non-negative numbers."),
 * then that it is 15 to 1440 (the ranges sentence). A plain `@Min(15)`
 * beside `@Min(0)` fails for -5 as well, and the two share class-validator's
 * `min` key, so which sentence survived would depend on decorator order. A
 * negative value is left to `@Min(0)`, so it gets the demo's first sentence
 * alone.
 */
function AtLeastUnlessNegative(
  min: number,
  options: ValidationOptions,
): PropertyDecorator {
  return ValidateBy(
    {
      name: 'atLeastUnlessNegative',
      constraints: [min],
      validator: {
        validate: (value: unknown) =>
          typeof value !== 'number' || value < 0 || value >= min,
      },
    },
    options,
  );
}

/** An optional alert switch on the staff bell. */
function AlertSetting(description: string) {
  return applyDecorators(
    ApiPropertyOptional({ description, example: true }),
    ValidateIf(isSent),
    IsBoolean({ message: ALERT_SWITCH_MESSAGE }),
  );
}

/**
 * Body of `PATCH /api/v1/staff/settings`: `settings.save` (plan §6.2).
 *
 * Send only what changes; a key left out keeps its value. A manager may
 * send an Owner-only key with its current value (the screen sends the whole
 * form), and is refused only for changing one, as in the demo. Business
 * details are `PATCH /staff/business`; the week's hours are
 * `PUT /staff/opening-hours`.
 */
export class UpdateSettingsRequest extends VersionedWriteDto {
  @RateSetting('VAT.', 750)
  vatBps?: number;

  @RateSetting('Service charge.', 0)
  serviceBps?: number;

  @MoneySetting('The booking deposit (kept at 0; D38).', 0)
  depositKobo?: number;

  @ApiPropertyOptional({
    description:
      'The Free Table Reminder, in minutes, 15 to 1440. A manager may ' +
      'change it.',
    minimum: 15,
    maximum: 1440,
    example: 180,
  })
  @ValidateIf(isSent)
  @IsInt({ message: SETTINGS_NUMBERS_MESSAGE })
  @Min(0, { message: SETTINGS_NUMBERS_MESSAGE })
  @AtLeastUnlessNegative(15, { message: SETTINGS_RANGES_MESSAGE })
  @Max(1440, { message: SETTINGS_RANGES_MESSAGE })
  freeTableReminderMinutes?: number;

  @MoneySetting('Delivery within Jos.', 500000)
  deliveryJosKobo?: number;

  @MoneySetting('Delivery elsewhere in Plateau State.', 1000000)
  deliveryOutsideKobo?: number;

  @MoneySetting('The Owner Approval Limit, per decision.', 5000000)
  approvalLimitKobo?: number;

  @ApiPropertyOptional({
    description: 'Whether the Daily Approval Limit applies. Owner only.',
    example: true,
  })
  @ValidateIf(isSent)
  @IsBoolean({ message: DAILY_LIMIT_SWITCH_MESSAGE })
  dailyLimitOn?: boolean;

  @MoneySetting('The Daily Approval Limit, per manager per day.', 15000000)
  dailyLimitKobo?: number;

  @ApiPropertyOptional({
    description: 'The receipt printer’s paper. A manager may change it.',
    enum: PrinterWidth,
    enumName: 'PrinterWidth',
  })
  @ValidateIf(isSent)
  @IsEnum(PrinterWidth, { message: PRINTER_WIDTH_MESSAGE })
  printerWidth?: PrinterWidth;

  @AlertSetting('The Low Stock alert. A manager may change it.')
  alertLowStock?: boolean;

  @AlertSetting('The approvals alert. A manager may change it.')
  alertApprovals?: boolean;

  @AlertSetting('The unsettled bills alert. A manager may change it.')
  alertUnsettled?: boolean;

  @AlertSetting('The expected arrivals alert. A manager may change it.')
  alertArrivals?: boolean;

  @TimeSetting(
    'The last table booking time, in WAT minutes from midnight (1380 is 23:00).',
    0,
    1380,
  )
  lastArrivalMinutes?: number;

  @TimeSetting(
    'The last online order slot, in WAT minutes from midnight (1410 is 23:30).',
    0,
    1410,
  )
  lastOrderSlotMinutes?: number;

  @TimeSetting('The online order slot grid, in minutes.', 1, 30)
  slotStepMinutes?: number;

  @TimeSetting('The pickup lead time, in minutes.', 1, 60)
  leadPickupMinutes?: number;

  @TimeSetting('The delivery lead time within Jos, in minutes.', 1, 90)
  leadJosMinutes?: number;

  @TimeSetting('The delivery lead time outside Jos, in minutes.', 1, 120)
  leadOutsideMinutes?: number;
}
