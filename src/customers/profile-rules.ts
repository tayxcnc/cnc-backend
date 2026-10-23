import { ContactChannel } from '../../generated/cnc-client';
import {
  NIGERIAN_PHONE,
  canonicalNigerianPhone,
} from '../common/nigerian-phone';

/**
 * The rules `PATCH /me` judges a profile change by (plan §5.2, C6-3), pure
 * so the unit suite covers them without a database. The sentences are the
 * account app's where it has one (`lib/account/api.ts`,
 * `components/account/panels.tsx`), byte for byte (A7); each new one says
 * why it is new.
 */

/** A phone that is not a Nigerian number (400). The account app's wording. */
export const PHONE_MESSAGE =
  'Enter a Nigerian phone number, for example 0803 123 4567.';

/**
 * Clearing the phone of an account with no email (400). The account app's
 * wording. Sign-in is by email (Q5), so today every account has one; a
 * customer made from a checkout (C7) may not.
 */
export const KEEP_A_CONTACT_MESSAGE =
  'Keep at least a phone number or an email.';

/**
 * A phone another account already holds (409). New: the demo kept one
 * profile per contact and never met two. `Customer.phone` is unique, so
 * the second account to save a number is refused rather than answered 500.
 */
export const PHONE_TAKEN_MESSAGE =
  'This phone number is already on another CNC account.';

/**
 * The street, area or town left blank (400). Your Details' own sentence
 * (`DetailsPanel`), which asks for the three together.
 */
export const PROFILE_ADDRESS_LINES_MESSAGE = 'Add the street, area and town.';

/**
 * A preference that is not on or off (400). New: the screen sends
 * switches, so only a hand-made request meets it.
 */
export const PREFERENCE_MESSAGE = 'Choose on or off for each notification.';

/** A channel that is not `EMAIL` or `SMS` (400). New, for the same reason. */
export const CHANNEL_MESSAGE = 'Choose how we send your updates.';

/**
 * News and Offers switched on (400). New: the plan stores the preference
 * false and refuses it until the founder enables news (plan §4.2); the
 * screen shows the switch locked, marked "Coming Soon".
 */
export const OFFERS_UNAVAILABLE_MESSAGE =
  'News and offers are not available yet.';

/**
 * Updates by SMS chosen (400). New: sign-in and messages are by email
 * only at launch (Q5, Q19's default: no SMS provider), so SMS is refused
 * rather than stored as a promise nobody keeps.
 */
export const SMS_UNAVAILABLE_MESSAGE = 'Updates by SMS are not available yet.';

/**
 * Updates by email chosen on an account with no email (400). The account
 * app's wording (`NotificationPrefs`).
 */
export const EMAIL_CHANNEL_NEEDS_EMAIL_MESSAGE =
  'Add an email address in Your Details to receive updates by email.';

/** The preference switches `PATCH /me` takes, as the account app names them. */
export const PREFERENCE_SWITCHES = [
  'orderUpdates',
  'bookingReminders',
  'offers',
] as const;

/** A preferences change: only the keys sent. */
export interface PrefsChange {
  orderUpdates?: boolean;
  bookingReminders?: boolean;
  offers?: boolean;
  channel?: ContactChannel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A phone as the account app takes it: spaces and dashes ignored, `0…`,
 * `+234…` and `234…` alike (its `phoneValid` and `normalisePhone`), stored
 * as `0` plus 10 digits. Null clears it, and so does blank text (the
 * screen's cleared field). Returns `undefined` for anything that is not a
 * Nigerian number.
 */
export function customerPhone(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;

  const compact = value.replace(/[\s-]/g, '');

  if (compact === '') return null;

  const prefixed = compact.startsWith('234') ? `+${compact}` : compact;

  return NIGERIAN_PHONE.test(prefixed)
    ? canonicalNigerianPhone(prefixed)
    : undefined;
}

/** The phone field's one sentence, or null. */
export function phoneProblem(value: unknown): string | null {
  return customerPhone(value) === undefined ? PHONE_MESSAGE : null;
}

/**
 * The shape of a preferences change, or its sentence: an object whose
 * switches, when sent, are true or false and whose channel, when sent, is
 * `EMAIL` or `SMS`. Whether a value is allowed is `prefsRuleBroken`'s.
 */
export function prefsProblem(value: unknown): string | null {
  if (!isRecord(value)) return PREFERENCE_MESSAGE;

  for (const key of PREFERENCE_SWITCHES) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      return PREFERENCE_MESSAGE;
    }
  }

  if (
    value.channel !== undefined &&
    !(Object.values(ContactChannel) as unknown[]).includes(value.channel)
  ) {
    return CHANNEL_MESSAGE;
  }

  return null;
}

/** A shape-checked preferences change with only the keys it sent. */
export function toPrefsChange(value: unknown): PrefsChange {
  if (!isRecord(value)) return {};

  const change: PrefsChange = {};

  for (const key of PREFERENCE_SWITCHES) {
    if (typeof value[key] === 'boolean') change[key] = value[key];
  }

  if ((Object.values(ContactChannel) as unknown[]).includes(value.channel)) {
    change.channel = value.channel as ContactChannel;
  }

  return change;
}

/**
 * Whether a preferences change may be stored, given the email the account
 * will hold: offers stay off and SMS stays unavailable until the founder
 * turns them on; email needs an email. Each is checked only when sent, so
 * a screen that sends every switch with offers off is never refused for
 * it.
 */
export function prefsRuleBroken(
  change: PrefsChange,
  email: string | null,
): string | null {
  if (change.offers === true) return OFFERS_UNAVAILABLE_MESSAGE;
  if (change.channel === ContactChannel.SMS) return SMS_UNAVAILABLE_MESSAGE;
  if (change.channel === ContactChannel.EMAIL && email === null) {
    return EMAIL_CHANNEL_NEEDS_EMAIL_MESSAGE;
  }

  return null;
}
