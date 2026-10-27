import { ApiPropertyOptional } from '@nestjs/swagger';
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
import { REASON_MAX_LENGTH } from '../../common/admin-reason';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
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
 * Body of `PATCH /api/v1/staff/people/:id`: `staff.save` for an existing
 * account.
 *
 * **Every field but `version` is optional, and a field left out is left as
 * it is** (plan §17, R2). The demo's `staff.save` set the status to Active
 * whenever none was sent, so a name fix silently re-enabled a deactivated
 * person; here `isActive` changes only when it is sent.
 */
export class UpdateStaffRequest extends VersionedWriteDto {
  @ApiPropertyOptional({
    description:
      'A corrected name. A change needs a `reason`: a new person needs a ' +
      'new account.',
    example: 'Grace James',
    maxLength: STAFF_NAME_MAX_LENGTH,
  })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: STAFF_NAME_AND_ROLE_MESSAGE })
  @IsNotEmpty({ message: STAFF_NAME_AND_ROLE_MESSAGE })
  @MaxLength(STAFF_NAME_MAX_LENGTH, {
    message: `A staff name must be ${STAFF_NAME_MAX_LENGTH} characters or fewer.`,
  })
  name?: string;

  @ApiPropertyOptional({
    description:
      'A new sign-in email. A change needs a `reason`, and ends every ' +
      'session the account holds.',
    example: 'grace.james@cnc.example',
    maxLength: 254,
  })
  @Transform(({ value }) => normaliseEmail(value))
  @ValidateIf(isSent)
  @IsString({ message: STAFF_EMAIL_INVALID_MESSAGE })
  @MaxLength(254, { message: STAFF_EMAIL_INVALID_MESSAGE })
  @Matches(EMAIL_PATTERN, { message: STAFF_EMAIL_INVALID_MESSAGE })
  email?: string;

  @ApiPropertyOptional({
    description:
      'A new role. Only the Owner may change a Manager or Owner account or ' +
      'make one. A change ends every session the account holds.',
    enum: StaffRole,
    enumName: 'StaffRole',
  })
  @ValidateIf(isSent)
  @IsEnum(StaffRole, { message: STAFF_NAME_AND_ROLE_MESSAGE })
  role?: StaffRole;

  @ApiPropertyOptional({
    description:
      'False deactivates the account: every route refuses it from its next ' +
      'request, and every session it holds ends. True reactivates it. Left ' +
      'out, the status is unchanged.',
    example: false,
  })
  @ValidateIf(isSent)
  @IsBoolean({ message: 'isActive must be true or false.' })
  isActive?: boolean;

  @ApiPropertyOptional({
    description:
      'Why a name or email is being corrected; recorded in the activity ' +
      'history.',
    example: 'Spelling corrected from her ID card',
    maxLength: REASON_MAX_LENGTH,
  })
  @ValidateIf(isSent)
  @IsString({ message: 'reason must be text.' })
  @MaxLength(REASON_MAX_LENGTH, {
    message: `reason must be ${REASON_MAX_LENGTH} characters or fewer.`,
  })
  reason?: string;
}
