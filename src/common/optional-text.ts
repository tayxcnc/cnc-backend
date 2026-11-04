import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ValidateIf } from 'class-validator';
import { Checked, textUpTo } from './checked';
import { isSent } from './is-sent';
import { noLongDashes } from './no-long-dashes';
import { trimText } from './trim-text';

/**
 * An optional free-text field: absent, or text of at most `max` characters
 * after trimming. `null` is refused like any other non-text value
 * (`isSent`), so a command never meets a value nothing checked. One
 * sentence per problem (`Checked`), so the staff app shows it once.
 *
 * Shared by every request that carries a note, a label or a guest name (a
 * stock issue's note, a count's reason, an order's label, guest and notes).
 *
 * `noLongDashes: true` also refuses a long dash, after the field's own
 * checks (`no-long-dashes.ts`). Only catalogue text takes it (decision
 * P18: menu items and vendors), never a note, a reason or a guest's name.
 */
export function OptionalText(
  name: string,
  max: number,
  options: { noLongDashes?: boolean } = {},
): PropertyDecorator {
  const problem = textUpTo(
    `${name} must be text.`,
    max,
    `${name} must be ${max} characters or fewer.`,
  );

  return applyDecorators(
    Transform(({ value }) => trimText(value)),
    ValidateIf(isSent),
    Checked(options.noLongDashes === true ? noLongDashes(problem) : problem),
  );
}
