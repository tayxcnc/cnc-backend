/**
 * The asset and repair sentences, byte for byte from the demo's
 * `asset.save` and `maintenance.save` (`staff/lib/domain.ts`, A7). The
 * screens show them as they stand. Sentences marked new have no demo
 * original.
 */

/** A blank tag or name, or a quantity that is not a whole number above zero. */
export const ASSET_FIELDS_MESSAGE = 'Enter a tag, name and quantity.';

/** A repair naming an asset or a vendor that does not exist. */
export const REPAIR_ASSET_VENDOR_MESSAGE = 'Select an asset and vendor.';

/** A blank description, or a cost that is not a whole number of kobo from zero. */
export const REPAIR_DESCRIPTION_COST_MESSAGE =
  'Enter a description and valid cost.';

/** A repair status that is not Pending, In Progress, Fixed or Not Fixed. */
export const REPAIR_STATUS_MESSAGE = 'Invalid repair status.';

/** A task that already tracks a repair, named for another one. */
export const TASK_HAS_REPAIR_MESSAGE =
  'This task already has a maintenance record.';

/**
 * A Purchase task named for a repair (400). New: the demo linked any task;
 * a task links only the record its type names (`Task_values_check`), and a
 * Purchase task already tracks a requisition.
 */
export const REPAIR_TASK_TYPE_MESSAGE = 'Choose a maintenance or general task.';

/**
 * An asset tag that names nothing, on an update (404). New: the demo saved
 * an unknown tag as a new asset; an update names the version it read, so it
 * names an asset that exists.
 */
export const ASSET_NOT_FOUND_MESSAGE = 'Asset not found.';

/**
 * A new asset whose tag is already taken (409). New: the demo replaced the
 * asset holding the tag; a create names no version, so it must not
 * overwrite a record nobody read.
 */
export const ASSET_TAG_TAKEN_MESSAGE = 'This asset tag already exists.';

/** An asset status that is not Active, Under Repair or Inactive (400). New. */
export const ASSET_STATUS_MESSAGE = 'Choose an asset status.';

/** A repair id that names nothing (404). New, in the form of "Task not found.". */
export const REPAIR_NOT_FOUND_MESSAGE = 'Maintenance record not found.';

/** A repairs or assets filter naming an unknown status (400). New. */
export const REPAIR_STATUS_FILTER_MESSAGE = 'Choose a repair status.';

/** Longest asset tag; new (the demo has none). */
export const ASSET_TAG_MAX_LENGTH = 40;

/** Longest asset name, category or location; new. */
export const ASSET_TEXT_MAX_LENGTH = 120;

/** Longest repair description; new. */
export const REPAIR_DESCRIPTION_MAX_LENGTH = 500;
