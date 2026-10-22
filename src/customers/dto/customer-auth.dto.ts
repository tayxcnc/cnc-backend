import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Checked } from '../../common/checked';
import { EMAIL_PATTERN } from '../../common/email-pattern';
import { normaliseEmail } from '../../common/normalise-email';
import { OTP_PATTERN } from '../one-time-code';
import { CustomerProfileResponse } from './customer-profile.response';

/**
 * A missing or malformed email on the sign-in screen (400). The sign-in
 * screen's own sentence (`components/account/SignIn.tsx`): sign-in is by
 * email only at launch (Q5).
 */
export const ENTER_EMAIL_MESSAGE = 'Enter your email address.';

/**
 * A code that is not six digits (400). The sign-in screen's sentence
 * ("Enter the 4 digit code."), with the server's six digits (A15).
 */
export const ENTER_CODE_MESSAGE = 'Enter the 6 digit code.';

/** Longest email the sign-in accepts: RFC 5321's limit on a path. */
const EMAIL_MAX_LENGTH = 254;

function emailProblem(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= EMAIL_MAX_LENGTH &&
    EMAIL_PATTERN.test(value)
    ? null
    : ENTER_EMAIL_MESSAGE;
}

/** Body of `POST /api/v1/auth/code`. */
export class RequestCodeRequest {
  @ApiProperty({
    description:
      'The email to send the code to. Trimmed and matched ' +
      'case-insensitively. A new email creates the account when its code ' +
      'is verified.',
    example: 'ada@example.com',
    format: 'email',
  })
  @Transform(({ value }) => normaliseEmail(value))
  @Checked(emailProblem)
  email!: string;
}

/** Answer of `POST /api/v1/auth/code`. Never the code. */
export class CodeSentResponse {
  @ApiProperty({
    example: 'a•••@example.com',
    description: 'The email the code went to, masked for the screen.',
  })
  sentTo!: string;

  @ApiProperty({
    example: 30,
    description: 'Seconds before another code may be asked for.',
  })
  resendInSec!: number;
}

/** Body of `POST /api/v1/auth/verify`. */
export class VerifyCodeRequest {
  @ApiProperty({
    description: 'The email the code was sent to.',
    example: 'ada@example.com',
    format: 'email',
  })
  @Transform(({ value }) => normaliseEmail(value))
  @Checked(emailProblem)
  email!: string;

  @ApiProperty({ description: 'The six-digit code.', example: '042817' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Checked((value) =>
    typeof value === 'string' && OTP_PATTERN.test(value)
      ? null
      : ENTER_CODE_MESSAGE,
  )
  code!: string;
}

/**
 * A customer session: `POST /auth/refresh`. The refresh token is never in
 * the body; it is in the `cnc_refresh_token` cookie.
 */
export class CustomerSessionResponse {
  @ApiProperty({ description: 'Bearer token, 15 minutes.' })
  accessToken!: string;

  @ApiProperty({ type: CustomerProfileResponse })
  customer!: CustomerProfileResponse;
}

/** Answer of `POST /api/v1/auth/verify`. */
export class CustomerSignInResponse extends CustomerSessionResponse {
  @ApiProperty({
    description:
      'True when the account has no name yet (a first sign-in): the app ' +
      'asks for one and saves it with `PATCH /me`.',
    example: true,
  })
  isNew!: boolean;
}
