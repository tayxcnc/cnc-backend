import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { MIN_PASSWORD_LENGTH } from '../password';

/**
 * Body of `POST /api/v1/auth/staff/change-password`, copied from TAY.
 *
 * `currentPassword` is required although the caller holds a valid token,
 * and that is the point: a token is a bearer credential, and without this a
 * stolen one (a till left signed in) could set a new password and lock the
 * real person out of their own account.
 */
export class ChangePasswordRequest {
  @ApiProperty({
    description:
      'The password being replaced: the temporary one at first sign-in. ' +
      'Verified before anything is written.',
    example: 'the-password-you-were-given',
    format: 'password',
  })
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @ApiProperty({
    description:
      `The new password, at least ${MIN_PASSWORD_LENGTH} characters and ` +
      'different from the current one. Hashed with argon2id and never ' +
      'returned.',
    example: 'correct-horse-battery',
    minLength: MIN_PASSWORD_LENGTH,
    format: 'password',
  })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  })
  newPassword!: string;
}
