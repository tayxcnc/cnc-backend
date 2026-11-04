import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsString, MaxLength, ValidateIf } from 'class-validator';
import { Checked, requiredText } from '../../common/checked';
import { PaginationQuery } from '../../common/dto/pagination.query';
import { VersionedWriteDto } from '../../common/dto/versioned-write.dto';
import { isSent } from '../../common/is-sent';
import { noLongDashes } from '../../common/no-long-dashes';
import { OptionalText } from '../../common/optional-text';
import { trimText } from '../../common/trim-text';
import {
  PURCHASING_NOTE_MAX_LENGTH,
  VENDOR_EMAIL_MAX_LENGTH,
  VENDOR_NAME_PHONE_MESSAGE,
  VENDOR_TEXT_MAX_LENGTH,
} from '../purchasing-messages';

/**
 * Each field answers one sentence at most (`Checked`): the staff app joins
 * every message of a 400 into what the screen shows, and the demo's
 * sentence must show once, as it stands (A7).
 */

/**
 * The name and phone: required, refused with the demo's one sentence, then
 * "Please rewrite this without long dashes." for a long dash (P18).
 */
const RequiredVendorText = (name: string) =>
  Checked(
    noLongDashes(
      requiredText(
        VENDOR_NAME_PHONE_MESSAGE,
        VENDOR_TEXT_MAX_LENGTH,
        `${name} must be ${VENDOR_TEXT_MAX_LENGTH} characters or fewer.`,
      ),
    ),
  );

/**
 * Body of `POST /staff/vendors` and `PATCH /staff/vendors/:id`:
 * `vendor.save`. The whole profile, as the Vendor Profile form sends it; an
 * optional text left out is saved empty, as in the demo.
 *
 * Every vendor field refuses a long dash (G2, decision P18) except the
 * notes: "Services / Procurement Notes" is a staff note, typed on an iPad
 * whose Smart Punctuation turns "--" into a long dash, and P18 never
 * refuses a staff note. The app cleans it where it shows it.
 */
export class SaveVendorFields {
  @ApiProperty({ example: 'Plateau Fresh Foods', maxLength: 120 })
  @Transform(({ value }) => trimText(value))
  @RequiredVendorText('name')
  name!: string;

  @ApiProperty({ example: '08000000010', maxLength: 120 })
  @Transform(({ value }) => trimText(value))
  @RequiredVendorText('phone')
  phone!: string;

  @ApiPropertyOptional({ example: 'Food supplies', maxLength: 120 })
  @OptionalText('service', VENDOR_TEXT_MAX_LENGTH, { noLongDashes: true })
  service?: string;

  @ApiPropertyOptional({ description: 'Contact person.', maxLength: 120 })
  @OptionalText('contact', VENDOR_TEXT_MAX_LENGTH, { noLongDashes: true })
  contact?: string;

  @ApiPropertyOptional({ maxLength: VENDOR_EMAIL_MAX_LENGTH })
  @OptionalText('email', VENDOR_EMAIL_MAX_LENGTH, { noLongDashes: true })
  email?: string;

  @ApiPropertyOptional({ maxLength: PURCHASING_NOTE_MAX_LENGTH })
  @OptionalText('address', PURCHASING_NOTE_MAX_LENGTH, { noLongDashes: true })
  address?: string;

  @ApiPropertyOptional({
    description: 'Services and procurement notes.',
    maxLength: PURCHASING_NOTE_MAX_LENGTH,
  })
  @OptionalText('notes', PURCHASING_NOTE_MAX_LENGTH)
  notes?: string;

  @ApiPropertyOptional({
    description:
      'Active or not. A new vendor is active unless this says otherwise; ' +
      'an edit that leaves it out keeps the vendor’s status (as R2 keeps a ' +
      'staff account’s), where the demo made the vendor Active again.',
  })
  @ValidateIf(isSent)
  @IsBoolean({ message: 'isActive must be true or false.' })
  isActive?: boolean;
}

/** Body of `POST /staff/vendors`. */
export class CreateVendorRequest extends SaveVendorFields {}

/**
 * Body of `PATCH /staff/vendors/:id`: the profile and the `version` it was
 * read at. `IntersectionType` carries both classes' validation and
 * transforms, so `VersionedWriteDto` stays the one home of the version's
 * checks.
 */
export class UpdateVendorRequest extends IntersectionType(
  SaveVendorFields,
  VersionedWriteDto,
) {}

/** `GET /staff/vendors`. */
export class VendorsQuery extends PaginationQuery {
  @ApiPropertyOptional({
    description:
      'Part of a vendor’s name, service, contact person or email, any case.',
  })
  @Transform(({ value }) => trimText(value))
  @ValidateIf(isSent)
  @IsString({ message: 'q must be text.' })
  @MaxLength(120, { message: 'q must be 120 characters or fewer.' })
  q?: string;
}

/** A vendor as the vendor routes answer it: the whole profile. */
export class VendorResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Plateau Fresh Foods' }) name!: string;
  @ApiProperty({ example: 'Food supplies' }) service!: string;
  @ApiProperty({ example: '08000000010' }) phone!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ description: 'Contact person.' }) contact!: string;
  @ApiProperty() address!: string;
  @ApiProperty() notes!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ example: 0 }) version!: number;
}

export class VendorPageResponse {
  @ApiProperty({ type: VendorResponse, isArray: true })
  data!: VendorResponse[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
}
