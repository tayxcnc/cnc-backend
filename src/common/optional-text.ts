import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';
import { Checked } from './checked';
import { isSent } from './is-sent';
import { trimText } from './trim-text';

/**
 * An optional free-text field: absent, or text of at most `max` characters
 * after trimming. `null` is refused like any other non-text value
 * (`isSent`), so a command never meets a value nothing checked. One
 * sentence per problem (`Checked`), so the staff app shows it once.
 *
 * Shared by every request that carries a note, a label or a guest name (a
 * stock issue's note, a count's reason, an order's label, guest and notes).
 */
export function OptionalText(name: string, max: number): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }) => trimText(value)),
    ValidateIf(isSent),
    Checked((value) => {
      if (typeof value !== 'string') return `${name} must be text.`;

      return value.length > max
        ? `${name} must be ${max} characters or fewer.`
        : null;
    }),
  );
}
