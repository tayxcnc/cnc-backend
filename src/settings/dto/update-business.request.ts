import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { EMAIL_PATTERN } from '../../common/email-pattern';
import { isSent } from '../../common/is-sent';
import { NIGERIAN_PHONE } from '../../common/nigerian-phone';
import { normaliseEmail } from '../../common/normalise-email';
import { trimText } from '../../common/trim-text';
import {
  BUSINESS_EMAIL_MESSAGE,
  BUSINESS_MAP_MESSAGE,
  BUSINESS_PHONE_MESSAGE,
  BUSINESS_REQUIRED_MESSAGE,
  BUSINESS_SOCIAL_MESSAGE,
} from '../settings-rules';

/** A network name: `instagram`, `facebook`, `tiktok`. */
const NETWORK = /^[a-z]{1,30}$/;

/** At most this many links. */
const MAX_SOCIAL_LINKS = 10;

/**
 * `socialLinks`: a flat object of network name to an `https://` link, at
 * most ten. Links are shown on the public site, so nothing but https.
 */
@ValidatorConstraint({ name: 'socialLinks', async: false })
export class SocialLinksShape implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const entries = Object.entries(value as Record<string, unknown>);

    return (
      entries.length <= MAX_SOCIAL_LINKS &&
      entries.every(
        ([network, link]) =>
          NETWORK.test(network) &&
          typeof link === 'string' &&
          link.length <= 300 &&
          /^https:\/\/[^\s]+$/.test(link),
      )
    );
  }

  defaultMessage(): string {
    return BUSINESS_SOCIAL_MESSAGE;
  }
}

/** A phone as typed, without the spaces, dashes and brackets people add. */
function stripPhone(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/[\s\-().]/g, '') : value;
}

/** Each address line trimmed; non-strings pass through to be refused. */
function trimLines(value: unknown): unknown {
  return Array.isArray(value) ? value.map(trimText) : value;
}

/**
 * Body of `PATCH /api/v1/staff/business`: the business half of the demo's
 * `settings.save` (plan §5.4), audited as `settings.save`. Managers may
 * change it. Send only what changes; the name, the address and the phone
 * may never end up blank.
 */
export class UpdateBusinessRequest extends VersionedWriteDto {
  @ApiPropertyOptional({ example: 'Chef Noro Culinary', maxLength: 120 })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: BUSINESS_REQUIRED_MESSAGE })
  @IsNotEmpty({ message: BUSINESS_REQUIRED_MESSAGE })
  @MaxLength(120, {
    message: 'The business name must be 120 characters or fewer.',
  })
  name?: string;

  @ApiPropertyOptional({
    description: 'One line, with no country; receipts print it.',
    example: '7A Hospital Place, opposite Water Board, Jos, Plateau State',
    maxLength: 200,
  })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: BUSINESS_REQUIRED_MESSAGE })
  @IsNotEmpty({ message: BUSINESS_REQUIRED_MESSAGE })
  @MaxLength(200, { message: 'The address must be 200 characters or fewer.' })
  addressLine?: string;

  @ApiPropertyOptional({
    description: 'The website’s multi-line form: one to four lines.',
    type: String,
    isArray: true,
    example: ['7A Hospital Place,', 'opposite Water Board, Jos'],
  })
  @Transform(({ value }) => trimLines(value))
  @ValidateIf(isSent)
  @IsArray({ message: BUSINESS_REQUIRED_MESSAGE })
  @ArrayMinSize(1, { message: BUSINESS_REQUIRED_MESSAGE })
  @ArrayMaxSize(4, { message: 'The address takes at most four lines.' })
  @IsString({ each: true, message: BUSINESS_REQUIRED_MESSAGE })
  @IsNotEmpty({ each: true, message: BUSINESS_REQUIRED_MESSAGE })
  @MaxLength(120, {
    each: true,
    message: 'Each address line must be 120 characters or fewer.',
  })
  addressLines?: string[];

  @ApiPropertyOptional({
    description:
      'A Nigerian number; spaces and dashes are removed and `+234` is ' +
      'stored as `0`.',
    example: '0802 218 8797',
  })
  @Transform(({ value }) => stripPhone(value))
  @ValidateIf(isSent)
  @IsString({ message: BUSINESS_REQUIRED_MESSAGE })
  @IsNotEmpty({ message: BUSINESS_REQUIRED_MESSAGE })
  @Matches(NIGERIAN_PHONE, { message: BUSINESS_PHONE_MESSAGE })
  phone?: string;

  @ApiPropertyOptional({
    description: 'Lower-cased. May be blank.',
    example: 'chefnoroculinarycnc@gmail.com',
  })
  @Transform(({ value }) => normaliseEmail(value))
  @ValidateIf(isSent)
  @IsString({ message: BUSINESS_EMAIL_MESSAGE })
  @MaxLength(254, { message: BUSINESS_EMAIL_MESSAGE })
  @ValidateIf((_owner, value) => value !== '')
  @Matches(EMAIL_PATTERN, { message: BUSINESS_EMAIL_MESSAGE })
  email?: string;

  @ApiPropertyOptional({ example: 'RC 765598', maxLength: 60 })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: 'The registration must be text.' })
  @MaxLength(60, {
    message: 'The registration must be 60 characters or fewer.',
  })
  registration?: string;

  /*
   * `@IsOptional` on the pin, not `@ValidateIf(isSent)`: null is a meaning
   * here (no pin), and the response carries null when there is none.
   */
  @ApiPropertyOptional({
    description: 'Latitude of the map pin, or null for none.',
    type: Number,
    nullable: true,
    example: 9.897137833050548,
  })
  @IsOptional()
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: BUSINESS_MAP_MESSAGE },
  )
  @Min(-90, { message: BUSINESS_MAP_MESSAGE })
  @Max(90, { message: BUSINESS_MAP_MESSAGE })
  mapLat?: number | null;

  @ApiPropertyOptional({
    description: 'Longitude of the map pin, or null for none.',
    type: Number,
    nullable: true,
    example: 8.889460545696355,
  })
  @IsOptional()
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: BUSINESS_MAP_MESSAGE },
  )
  @Min(-180, { message: BUSINESS_MAP_MESSAGE })
  @Max(180, { message: BUSINESS_MAP_MESSAGE })
  mapLng?: number | null;

  @ApiPropertyOptional({
    description:
      'Network name to an https link, at most ten; the whole set replaces ' +
      'the stored one. `{}` clears them.',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { instagram: 'https://www.instagram.com/example' },
  })
  @ValidateIf(isSent)
  @Validate(SocialLinksShape)
  socialLinks?: Record<string, string>;
}
