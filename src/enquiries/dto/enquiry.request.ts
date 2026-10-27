import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Allow, ValidateIf } from 'class-validator';
import { Checked, calendarDate, requiredText } from '../../common/checked';
import { EMAIL_PATTERN } from '../../common/email-pattern';
import { isSent } from '../../common/is-sent';
import { normaliseEmail } from '../../common/normalise-email';
import { trimText } from '../../common/trim-text';
import { customerPhone } from '../../customers/profile-rules';
import { RESERVATION_DATE_MESSAGE } from '../../reception/reception-messages';
import {
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_EMAIL_MESSAGE,
  CONTACT_MESSAGE_LENGTH_MESSAGE,
  CONTACT_MESSAGE_MAX_LENGTH,
  CONTACT_NAME_LENGTH_MESSAGE,
  CONTACT_NAME_MAX_LENGTH,
  CONTACT_REQUIRED_MESSAGE,
  CONTACT_SUBJECT_MAX_LENGTH,
  CONTACT_SUBJECT_MESSAGE,
  GROUP_EMAIL_MESSAGE,
  GROUP_GUESTS_MAX_LENGTH,
  GROUP_GUESTS_MESSAGE,
  GROUP_MESSAGE_LENGTH_MESSAGE,
  GROUP_MESSAGE_MAX_LENGTH,
  GROUP_NAME_LENGTH_MESSAGE,
  GROUP_NAME_MAX_LENGTH,
  GROUP_NAME_MESSAGE,
  GROUP_PHONE_MESSAGE,
  GROUP_VENUE_MESSAGE,
} from '../enquiry-messages';

/** Trimmed text that is not empty. */
const filled = (value: unknown): boolean =>
  typeof value === 'string' && value.trim() !== '';

const Trimmed = () => Transform(({ value }) => trimText(value));

/**
 * An optional field of the large-group form: absent or null is "not
 * given", as the form sends an empty input either way.
 */
const sentAndNotNull = (owner: object, value: unknown): boolean =>
  isSent(owner, value) && value !== null;

/**
 * The honeypot (plan §5.1, D50): a field no person sees (`company`, the
 * website's hidden "Company" input). Declared so the whitelist lets a bot's
 * value through to the service, which then answers as though the enquiry
 * was received and keeps nothing. Never validated: whatever a bot sends,
 * of whatever type, means the same thing.
 */
const Honeypot = () =>
  applyDecorators(
    ApiPropertyOptional({
      description:
        'Leave empty. The forms hide it from people; anything in it marks ' +
        'the request as automated, and nothing is kept or sent.',
    }),
    Allow(),
  );

/**
 * `POST /enquiries` (plan §5.1, card C6-7): the Contact page's form
 * (`EnquiryForm`). A missing name, email or message is the site's one
 * sentence, said once: the email is judged only after the name is in, and
 * the message after both.
 */
export class ContactEnquiryRequest {
  @ApiProperty({ example: 'Ada Okafor', maxLength: CONTACT_NAME_MAX_LENGTH })
  @Trimmed()
  @Checked(
    requiredText(
      CONTACT_REQUIRED_MESSAGE,
      CONTACT_NAME_MAX_LENGTH,
      CONTACT_NAME_LENGTH_MESSAGE,
    ),
  )
  name!: string;

  @ApiProperty({ example: 'ada@example.com' })
  @Transform(({ value }) => normaliseEmail(value))
  @ValidateIf((request: ContactEnquiryRequest) => filled(request.name))
  @Checked((value) => {
    if (!filled(value)) return CONTACT_REQUIRED_MESSAGE;

    return typeof value === 'string' &&
      value.length <= CONTACT_EMAIL_MAX_LENGTH &&
      EMAIL_PATTERN.test(value)
      ? null
      : CONTACT_EMAIL_MESSAGE;
  })
  email!: string;

  @ApiProperty({
    example: 'Dining enquiry',
    description: 'The form’s "What can we help with?" choice.',
  })
  @Trimmed()
  @Checked(
    requiredText(
      CONTACT_SUBJECT_MESSAGE,
      CONTACT_SUBJECT_MAX_LENGTH,
      CONTACT_SUBJECT_MESSAGE,
    ),
  )
  subject!: string;

  @ApiProperty({ maxLength: CONTACT_MESSAGE_MAX_LENGTH })
  @Trimmed()
  @ValidateIf(
    (request: ContactEnquiryRequest) =>
      filled(request.name) && filled(request.email),
  )
  @Checked(
    requiredText(
      CONTACT_REQUIRED_MESSAGE,
      CONTACT_MESSAGE_MAX_LENGTH,
      CONTACT_MESSAGE_LENGTH_MESSAGE,
    ),
  )
  message!: string;

  @Honeypot()
  company?: unknown;
}

/**
 * `POST /group-enquiries` (plan §5.1, card C6-7): the booking page's
 * large-party callback (`LargeGroup`), shown when the party is at the
 * room's `bigParty` or more. The phone is required so CNC can call back,
 * and is stored as `0` plus 10 digits; the room is named by its slug, as
 * `POST /reservations` names it.
 */
export class GroupEnquiryRequest {
  @ApiProperty({ example: 'Ada Okafor', maxLength: GROUP_NAME_MAX_LENGTH })
  @Trimmed()
  @Checked(
    requiredText(
      GROUP_NAME_MESSAGE,
      GROUP_NAME_MAX_LENGTH,
      GROUP_NAME_LENGTH_MESSAGE,
    ),
  )
  name!: string;

  @ApiProperty({
    example: '0803 123 4567',
    description: 'A Nigerian number to call back, typed any usual way.',
  })
  @Checked((value) =>
    typeof customerPhone(value) === 'string' ? null : GROUP_PHONE_MESSAGE,
  )
  phone!: string;

  @ApiPropertyOptional({
    example: 'ada@example.com',
    description: 'Optional; empty is the same as absent.',
  })
  @Transform(({ value }) => normaliseEmail(value))
  @ValidateIf(sentAndNotNull)
  @Checked((value) =>
    value === '' ||
    (typeof value === 'string' &&
      value.length <= CONTACT_EMAIL_MAX_LENGTH &&
      EMAIL_PATTERN.test(value))
      ? null
      : GROUP_EMAIL_MESSAGE,
  )
  email?: string;

  @ApiProperty({ example: 'lounge', description: 'Venue.slug.' })
  @Trimmed()
  @Checked(requiredText(GROUP_VENUE_MESSAGE, 64, GROUP_VENUE_MESSAGE))
  venue!: string;

  @ApiProperty({
    example: '2026-10-24',
    description: 'YYYY-MM-DD, today or later in Jos.',
  })
  @Checked(calendarDate(RESERVATION_DATE_MESSAGE))
  date!: string;

  @ApiProperty({
    example: '6 guests',
    maxLength: GROUP_GUESTS_MAX_LENGTH,
    description: 'The form’s text, kept as typed.',
  })
  @Trimmed()
  @Checked(
    requiredText(
      GROUP_GUESTS_MESSAGE,
      GROUP_GUESTS_MAX_LENGTH,
      GROUP_GUESTS_MESSAGE,
    ),
  )
  guests!: string;

  @ApiPropertyOptional({
    maxLength: GROUP_MESSAGE_MAX_LENGTH,
    description: '"Anything we should know".',
  })
  @Trimmed()
  @ValidateIf(sentAndNotNull)
  @Checked((value) =>
    typeof value === 'string' && value.length <= GROUP_MESSAGE_MAX_LENGTH
      ? null
      : GROUP_MESSAGE_LENGTH_MESSAGE,
  )
  message?: string;

  @Honeypot()
  company?: unknown;
}
