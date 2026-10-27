import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { StaffRole } from '../../../generated/cnc-client';
import { EMAIL_PATTERN } from '../../common/email-pattern';
import { isSent } from '../../common/is-sent';
import { normaliseEmail } from '../../common/normalise-email';
import { trimText } from '../../common/trim-text';
import {
  STAFF_EMAIL_INVALID_MESSAGE,
  STAFF_NAME_AND_ROLE_MESSAGE,
  STAFF_NAME_MAX_LENGTH,
} from '../staff-messages';

/**
 * Body of `POST /api/v1/staff/people`: `staff.save` for a new person.
 *
 * The staff number, the first password, the QR token and the joining date
 * are the server's, never the caller's: the number comes from its sequence,
 * the password is a random temporary one returned once, the token is minted
 * by `generateQrToken`, and the date is today in Lagos.
 */
export class CreateStaffRequest {
  @ApiProperty({
    description: 'The person’s name as colleagues know it. Trimmed.',
    example: 'Grace James',
    maxLength: STAFF_NAME_MAX_LENGTH,
  })
  @Transform(({ value }) => trimText(value))
  @IsString({ message: STAFF_NAME_AND_ROLE_MESSAGE })
  @IsNotEmpty({ message: STAFF_NAME_AND_ROLE_MESSAGE })
  @MaxLength(STAFF_NAME_MAX_LENGTH, {
    message: `A staff name must be ${STAFF_NAME_MAX_LENGTH} characters or fewer.`,
  })
  name!: string;

  @ApiProperty({
    description:
      'The work email the person signs in with. Trimmed and lower-cased; ' +
      'unique across staff accounts.',
    example: 'grace.james@cnc.example',
    maxLength: 254,
  })
  @Transform(({ value }) => normaliseEmail(value))
  @IsString({ message: STAFF_EMAIL_INVALID_MESSAGE })
  @MaxLength(254, { message: STAFF_EMAIL_INVALID_MESSAGE })
  @Matches(EMAIL_PATTERN, { message: STAFF_EMAIL_INVALID_MESSAGE })
  email!: string;

  @ApiProperty({
    description:
      'One role per person. Only the Owner may create a MANAGER or OWNER ' +
      'account.',
    enum: StaffRole,
    enumName: 'StaffRole',
    example: StaffRole.CASHIER,
  })
  @IsEnum(StaffRole, { message: STAFF_NAME_AND_ROLE_MESSAGE })
  role!: StaffRole;

  @ApiPropertyOptional({
    description: 'Whether the account may sign in. Defaults to true.',
    example: true,
  })
  @ValidateIf(isSent)
  @IsBoolean({ message: 'isActive must be true or false.' })
  isActive?: boolean;
}
