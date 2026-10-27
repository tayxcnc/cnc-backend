import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { normaliseEmail } from '../../common/normalise-email';

/**
 * Body of `POST /api/v1/auth/staff/sign-in`.
 *
 * No rule on `password` beyond presence: password policy stops a weak
 * password being created, and applying it at sign-in only tells a guesser
 * which passwords not to try.
 */
export class StaffSignInRequest {
  @ApiProperty({
    description: 'Work email address. Matched case-insensitively.',
    example: 'ada@cnc.example',
    format: 'email',
  })
  @Transform(({ value }) => normaliseEmail(value))
  @IsEmail({}, { message: 'email must be a valid email address.' })
  email!: string;

  @ApiProperty({
    description: 'Plaintext password.',
    example: 'correct-horse-battery',
    format: 'password',
  })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
