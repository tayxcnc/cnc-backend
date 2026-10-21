/**
 * Which `Settings` keys a manager may change, and the sentences a refused
 * or malformed `settings.save` answers with (plan §6.2; `staff/lib/
 * domain.ts`, `settings.save`).
 */

/**
 * The demo's eight Owner-only keys (`domain.ts`, D36), in the schema's
 * names: tax, service charge, the deposit, both delivery fees, the approval
 * limit, and the daily limit's switch and amount.
 */
export const OWNER_MONEY_SETTINGS = [
  'vatBps',
  'serviceBps',
  'depositKobo',
  'deliveryJosKobo',
  'deliveryOutsideKobo',
  'approvalLimitKobo',
  'dailyLimitOn',
  'dailyLimitKobo',
] as const;

/**
 * The six booking and ordering times: Owner-only until Q29 is answered, by
 * its default ("the Owner only, like VAT and fees").
 */
export const OWNER_TIME_SETTINGS = [
  'lastArrivalMinutes',
  'lastOrderSlotMinutes',
  'slotStepMinutes',
  'leadPickupMinutes',
  'leadJosMinutes',
  'leadOutsideMinutes',
] as const;

/**
 * What a manager keeps (the demo's owner test: "a manager keeps printer,
 * alerts and the free table reminder").
 */
export const MANAGER_SETTINGS = [
  'freeTableReminderMinutes',
  'printerWidth',
  'alertLowStock',
  'alertApprovals',
  'alertUnsettled',
  'alertArrivals',
] as const;

/** Every key `settings.save` may write. */
export const SETTINGS_KEYS = [
  ...OWNER_MONEY_SETTINGS,
  ...OWNER_TIME_SETTINGS,
  ...MANAGER_SETTINGS,
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

/** A value that is not a whole number of 0 or more (the demo's sentence). */
export const SETTINGS_NUMBERS_MESSAGE =
  'Settings must be non-negative numbers.';

/** VAT or service above 100%, or the reminder outside 15–1440 (the demo's). */
export const SETTINGS_RANGES_MESSAGE =
  'Check tax, service charge or the free table reminder (15 to 1440 minutes).';

/** The daily limit switch that is not true or false (the demo's). */
export const DAILY_LIMIT_SWITCH_MESSAGE = 'Daily limit must be on or off.';

/** An unknown printer paper width (the demo's). */
export const PRINTER_WIDTH_MESSAGE = 'Choose a printer paper width.';

/** An alert switch that is not true or false. New: the demo had no check. */
export const ALERT_SWITCH_MESSAGE = 'Alerts must be on or off.';

/**
 * A booking or ordering time out of range. New: the demo had no such keys.
 * The ranges are the migration's CHECK, so the database never sees a value
 * this lets through.
 */
export const SETTINGS_TIMES_MESSAGE =
  'Check the booking and ordering times: a time of day is 0 to 1440 ' +
  'minutes, and the slot step and lead times are 1 to 1440 minutes.';

/**
 * Larger than a Postgres `integer` holds. New: the demo stored any number
 * in the browser.
 */
export const SETTINGS_TOO_LARGE_MESSAGE =
  'That number is too large for this setting.';

/**
 * A business name, address or phone left blank (the demo's `settings.save`
 * sentence for the business part, which `PATCH /staff/business` now is).
 */
export const BUSINESS_REQUIRED_MESSAGE =
  'Business name, address and phone are required for receipts.';

/** A business email that is not an address (the demo's). */
export const BUSINESS_EMAIL_MESSAGE = 'Enter a valid business email.';

/**
 * A business phone that is not a Nigerian number. New: the demo stored any
 * text, but the column holds digits that every screen formats, so a value
 * with letters or a foreign shape would print wrongly on every receipt.
 */
export const BUSINESS_PHONE_MESSAGE =
  'Enter the business phone as a Nigerian number, for example 0802 218 8797.';

/** A map pin outside the globe. New. */
export const BUSINESS_MAP_MESSAGE =
  'The map pin must be a latitude from -90 to 90 and a longitude from -180 to 180.';

/** Social links that are not network names mapped to https links. New. */
export const BUSINESS_SOCIAL_MESSAGE =
  'Social links must map a network name (lower-case letters) to an https:// link.';
