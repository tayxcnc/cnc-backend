/**
 * The enquiry forms' sentences (card C6-7). The website's own words where
 * it has them (`cnc-frontend/lib/enquiries.ts`), byte for byte; each new
 * one is marked with why it is needed.
 */

/** The contact form: a name, an email or a message missing (the site's). */
export const CONTACT_REQUIRED_MESSAGE =
  'Please add your name, your email and a message.';

/**
 * New: the site relies on the browser's email check; the server must say
 * something when one gets past it.
 */
export const CONTACT_EMAIL_MESSAGE =
  'Please add a valid email address so we can reply.';

/** New: the subject is the form's required "What can we help with?". */
export const CONTACT_SUBJECT_MESSAGE = 'Choose what we can help with.';

/** New: the form's `maxLength` on the name (100). */
export const CONTACT_NAME_MAX_LENGTH = 100;
export const CONTACT_NAME_LENGTH_MESSAGE = `Keep your name to ${CONTACT_NAME_MAX_LENGTH} characters.`;

/** The form's `maxLength` on the email (200). */
export const CONTACT_EMAIL_MAX_LENGTH = 200;

/** The longest subject accepted: the form's options are all far shorter. */
export const CONTACT_SUBJECT_MAX_LENGTH = 100;

/** New: the form's `maxLength` on the message (3000). */
export const CONTACT_MESSAGE_MAX_LENGTH = 3000;
export const CONTACT_MESSAGE_LENGTH_MESSAGE = `Keep your message to ${CONTACT_MESSAGE_MAX_LENGTH} characters.`;

/** The large-group form: no name (the site's). */
export const GROUP_NAME_MESSAGE = 'Please add your name.';

/** New: the form's `maxLength` on the name (80). */
export const GROUP_NAME_MAX_LENGTH = 80;
export const GROUP_NAME_LENGTH_MESSAGE = `Keep your name to ${GROUP_NAME_MAX_LENGTH} characters.`;

/** The large-group form: no Nigerian phone to call back (the site's). */
export const GROUP_PHONE_MESSAGE =
  'Please add a phone number we can call you back on, for example 0803 123 4567.';

/** New: the email is optional on this form, so the sentence says so. */
export const GROUP_EMAIL_MESSAGE =
  'Please add a valid email address, or leave it empty.';

/** New: the room is chosen on the booking page before this form shows. */
export const GROUP_VENUE_MESSAGE = 'Choose Dining or the Lounge.';

/** New: the form's required "Number of guests" (at most 30 characters). */
export const GROUP_GUESTS_MAX_LENGTH = 30;
export const GROUP_GUESTS_MESSAGE = 'Please add the number of guests.';

/** New: the form's `maxLength` on "Anything we should know" (600). */
export const GROUP_MESSAGE_MAX_LENGTH = 600;
export const GROUP_MESSAGE_LENGTH_MESSAGE = `Keep your note to ${GROUP_MESSAGE_MAX_LENGTH} characters.`;
