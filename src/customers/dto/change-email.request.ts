import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Checked } from '../../common/checked';
import { normaliseEmail } from '../../common/normalise-email';
import { codeProblem, emailCheck } from './customer-auth.dto';

/**
 * A missing or malformed new email (400). The account app's sentence for
 * an email in Your Details (`updateProfile`), which these routes replace.
 */
export const CHECK_EMAIL_MESSAGE = 'Check the email address.';

const newEmailProblem = emailCheck(CHECK_EMAIL_MESSAGE);

/** Body of `POST /api/v1/me/email/code`. */
export class ChangeEmailCodeRequest {
  @ApiProperty({
    description:
      'The new email. Trimmed and lower-cased; the code goes to it, and the ' +
      'account keeps its current email until the code is verified.',
    example: 'ada.obi@example.com',
    format: 'email',
  })
  @Transform(({ value }) => normaliseEmail(value))
  @Checked(newEmailProblem)
  email!: string;
}

/** Body of `POST /api/v1/me/email/verify`. */
export class ChangeEmailVerifyRequest {
  @ApiProperty({
    description: 'The new email the code was sent to.',
    example: 'ada.obi@example.com',
    format: 'email',
  })
  @Transform(({ value }) => normaliseEmail(value))
  @Checked(newEmailProblem)
  email!: string;

  @ApiProperty({ description: 'The six-digit code.', example: '042817' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Checked(codeProblem)
  code!: string;
}
