import {
  AssetStatus,
  MaintenanceStatus,
  TaskType,
} from '../../generated/cnc-client';
import { INT4_MAX } from '../prisma/int4';
import {
  ASSET_FIELDS_MESSAGE,
  ASSET_TAG_MAX_LENGTH,
  ASSET_TEXT_MAX_LENGTH,
  REPAIR_DESCRIPTION_COST_MESSAGE,
  REPAIR_DESCRIPTION_MAX_LENGTH,
  REPAIR_TASK_TYPE_MESSAGE,
  TASK_HAS_REPAIR_MESSAGE,
} from './asset-messages';

/**
 * The asset and repair rules (plan §4.7, §7.9, §17 R3), pure, from the
 * demo's `asset.save` and `maintenance.save` (`staff/lib/domain.ts`), so
 * each is unit-tested without a database. Repairs are reactive only (Q13's
 * default): a repair is logged when something breaks, and there is no
 * preventive schedule.
 */

/** Text as sent, trimmed, or undefined for anything that is not text. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * The demo's `asset.save` check: a tag, a name and a quantity that is a
 * whole number above zero, answered with its one sentence. A tag or name
 * longer than the columns allow gets its own length sentence. Null when the
 * fields are good.
 */
export function assetFieldsProblem(
  tag: unknown,
  name: unknown,
  quantity: unknown,
): string | null {
  const tagText = text(tag);
  const nameText = text(name);

  if (
    !tagText ||
    !nameText ||
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > INT4_MAX
  ) {
    return ASSET_FIELDS_MESSAGE;
  }

  if (tagText.length > ASSET_TAG_MAX_LENGTH) {
    return `tag must be ${ASSET_TAG_MAX_LENGTH} characters or fewer.`;
  }

  return nameText.length > ASSET_TEXT_MAX_LENGTH
    ? `name must be ${ASSET_TEXT_MAX_LENGTH} characters or fewer.`
    : null;
}

/**
 * The demo's `maintenance.save` check on the work: a description that is
 * not blank and a cost that is a whole number of kobo from zero (the demo's
 * `integer`), answered with its one sentence. Null when both are good.
 */
export function repairFieldsProblem(
  description: unknown,
  costKobo: unknown,
): string | null {
  const descriptionText = text(description);

  if (
    !descriptionText ||
    typeof costKobo !== 'number' ||
    !Number.isInteger(costKobo) ||
    costKobo < 0 ||
    costKobo > INT4_MAX
  ) {
    return REPAIR_DESCRIPTION_COST_MESSAGE;
  }

  return descriptionText.length > REPAIR_DESCRIPTION_MAX_LENGTH
    ? `description must be ${REPAIR_DESCRIPTION_MAX_LENGTH} characters or fewer.`
    : null;
}

/** Whether a value is one of the four repair statuses. */
export function isRepairStatus(value: unknown): value is MaintenanceStatus {
  return (
    typeof value === 'string' &&
    (Object.values(MaintenanceStatus) as string[]).includes(value)
  );
}

/** The two statuses that close a repair (the demo's `['Fixed','Not Fixed']`). */
export const CLOSED_REPAIR_STATUSES: readonly MaintenanceStatus[] = [
  MaintenanceStatus.FIXED,
  MaintenanceStatus.NOT_FIXED,
];

/** Whether a repair status closes the repair. */
export function isResolved(status: MaintenanceStatus): boolean {
  return CLOSED_REPAIR_STATUSES.includes(status);
}

/**
 * The asset's status as its repair leaves it, the demo's rule: Under Repair
 * while the repair is Pending or In Progress, Active once Fixed, Inactive
 * when it could not be fixed.
 */
export function assetStatusForRepair(status: MaintenanceStatus): AssetStatus {
  switch (status) {
    case MaintenanceStatus.FIXED:
      return AssetStatus.ACTIVE;
    case MaintenanceStatus.NOT_FIXED:
      return AssetStatus.INACTIVE;
    default:
      return AssetStatus.UNDER_REPAIR;
  }
}

/**
 * The resolved date after a save (plan §17, R3): set once, to today, on the
 * first move to Fixed or Not Fixed, and never reset after. The demo set it
 * to today on every save of a closed repair, so editing a fixed repair's
 * cost a week later moved the day it was fixed, and cleared it whenever the
 * repair was reopened.
 */
export function resolvedOnFor(
  stored: Date | null,
  status: MaintenanceStatus,
  today: Date,
): Date | null {
  if (stored !== null) return stored;

  return isResolved(status) ? today : null;
}

/** The follow-up task a new repair raises for a manager (the demo's title). */
export function followUpTitle(number: string, assetName: string): string {
  return `Follow up repair ${number}: ${assetName || 'asset'}`;
}

/**
 * Whether a task may be linked to a repair by `maintenance.save` with a
 * task: one that already tracks a repair is refused with the demo's
 * sentence, and a Purchase task (which tracks a requisition) with the new
 * one; a General or Maintenance task is linked and becomes a Maintenance
 * task, so it stays inside `Task_values_check`. Null when it may.
 */
export function repairTaskProblem(task: {
  type: TaskType;
  maintenanceId: string | null;
}): string | null {
  if (task.maintenanceId !== null) return TASK_HAS_REPAIR_MESSAGE;

  return task.type === TaskType.PURCHASE ? REPAIR_TASK_TYPE_MESSAGE : null;
}
