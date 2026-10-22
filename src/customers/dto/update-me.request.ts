import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional } from 'class-validator';
import { Checked, requiredText } from '../../common/checked';

/**
 * A blank name (400). The sign-in screen's sentence for its first-time name
 * step (`components/account/SignIn.tsx`).
 */
export const ADD_YOUR_NAME_MESSAGE = 'Add your name.';

/** The name field's length, as the screen's input caps it (`maxLength`). */
export const CUSTOMER_NAME_MAX_LENGTH = 80;

/** A name longer than the screen allows (400). */
export const NAME_TOO_LONG_MESSAGE = `Keep your name to ${CUSTOMER_NAME_MAX_LENGTH} characters.`;

/**
 * Body of `PATCH /api/v1/me`. Each field changes only when it is sent.
 *
 * C6-2 carries the name alone, which is what the first-time name step
 * saves; C6-3 adds the phone, the address and the preferences beside it.
 * Email and photo never travel here (plan §5.2): each has its own route.
 */
export class UpdateMeRequest {
  @ApiPropertyOptional({
    description: 'Full name, 1 to 80 characters after trimming.',
    example: 'Ada Obi',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @Checked(
    requiredText(
      ADD_YOUR_NAME_MESSAGE,
      CUSTOMER_NAME_MAX_LENGTH,
      NAME_TOO_LONG_MESSAGE,
    ),
  )
  name?: string;
}
