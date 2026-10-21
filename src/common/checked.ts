import { registerDecorator } from 'class-validator';
import { INT4_MAX } from '../prisma/int4';
import { parseIsoDate } from './calendar-date';

/**
 * Validate a field with one function that names its one problem.
 *
 * Why not stacked class-validator decorators: each failing decorator adds
 * its own message, so a missing reason under `@IsString`, `@IsNotEmpty` and
 * `@MaxLength` answers three sentences, two of them the same, and the staff
 * app joins every message of a 400 into what the screen shows. A domain
 * sentence must reach the screen as it stands (A7), once. `problem`
 * returns that sentence, or null when the value is good.
 */
export function Checked(
  problem: (value: unknown) => string | null,
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    registerDecorator({
      name: 'checked',
      target: target.constructor,
      propertyName: String(propertyKey),
      validator: {
        validate: (value: unknown) => problem(value) === null,
        defaultMessage: (args) => problem(args?.value) ?? '',
      },
    });
  };
}

/**
 * Required text: a string that is not blank after trimming (the field is
 * trimmed by its `@Transform` first) and at most `maxLength` characters.
 */
export function requiredText(
  message: string,
  maxLength: number,
  tooLong: string,
): (value: unknown) => string | null {
  return (value) => {
    if (typeof value !== 'string' || value.trim() === '') return message;

    return value.length > maxLength ? tooLong : null;
  };
}

/**
 * A business date: a `YYYY-MM-DD` string naming a real day
 * (`parseIsoDate`), never an instant (*Contract conventions*). Shared by
 * every request and query that names a business date, so each answers its
 * own one sentence.
 */
export function calendarDate(
  message: string,
): (value: unknown) => string | null {
  return (value) =>
    typeof value === 'string' && parseIsoDate(value) !== null ? null : message;
}

/**
 * A whole number from `min` to the largest `Int` column value: a larger
 * number would reach Postgres as an out-of-range 500.
 */
export function wholeNumber(
  min: number,
  message: string,
): (value: unknown) => string | null {
  return (value) =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= INT4_MAX
      ? null
      : message;
}
