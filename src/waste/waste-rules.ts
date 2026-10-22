import {
  StaffRole,
  StockLocation,
  StockMovementType,
  WasteReason,
  WasteStatus,
} from '../../generated/cnc-client';
import { INT4_MAX } from '../prisma/int4';
import {
  BAR_WASTE_ONLY_MESSAGE,
  KITCHEN_WASTE_ONLY_MESSAGE,
  STORE_WASTE_ONLY_MESSAGE,
} from './waste-messages';

/**
 * The waste rules (plan §4.6, §7.8), pure, from the demo's `waste.create`,
 * `waste.edit`, `waste.status`, `waste.approve` and `waste.reject`
 * (`staff/lib/domain.ts`), so each is unit-tested without a database.
 */

/**
 * The one location a role logs and reads waste at (plan §6.1): a Kitchen
 * user the Kitchen, a Bartender or a Cashier (from the till) the Bar, the
 * Storekeeper the Store. Undefined for managers, who log and read every
 * location. The demo's `WasteRecords` and `WasteForm` scope by the same
 * table.
 */
export function wasteLocationFor(role: StaffRole): StockLocation | undefined {
  switch (role) {
    case StaffRole.KITCHEN:
      return StockLocation.KITCHEN;
    case StaffRole.BARTENDER:
    case StaffRole.CASHIER:
      return StockLocation.BAR;
    case StaffRole.STOREKEEPER:
      return StockLocation.STORE;
    default:
      return undefined;
  }
}

/** The sentence a role is refused with when it logs waste elsewhere. */
const OWN_LOCATION_MESSAGE: Partial<Record<StaffRole, string>> = {
  [StaffRole.KITCHEN]: KITCHEN_WASTE_ONLY_MESSAGE,
  [StaffRole.BARTENDER]: BAR_WASTE_ONLY_MESSAGE,
  [StaffRole.CASHIER]: BAR_WASTE_ONLY_MESSAGE,
  [StaffRole.STOREKEEPER]: STORE_WASTE_ONLY_MESSAGE,
};

/**
 * The demo's location rule on `waste.create`: each role logs waste at its
 * own location only, refused with its own sentence ("Kitchen staff can log
 * kitchen waste only."). Null when the role may log at `location`
 * (managers anywhere).
 */
export function ownLocationProblem(
  role: StaffRole,
  location: StockLocation,
): string | null {
  const own = wasteLocationFor(role);

  return own === undefined || own === location
    ? null
    : (OWN_LOCATION_MESSAGE[role] ?? null);
}

/** Whether a value is one of the six waste reasons. */
export function isWasteReason(value: unknown): value is WasteReason {
  return (
    typeof value === 'string' &&
    (Object.values(WasteReason) as string[]).includes(value)
  );
}

/**
 * The demo's one check on a write-off's figure and reason: a whole
 * quantity above zero and one of the six reasons, refused with `message`
 * (`waste.create` and `waste.edit` word it differently). A quantity that
 * would not fit an `Int` column fails the same check rather than reaching
 * Postgres as a 500. Null when both are good.
 */
export function qtyReasonProblem(
  qty: unknown,
  reason: unknown,
  message: string,
): string | null {
  const wholeQty =
    typeof qty === 'number' &&
    Number.isInteger(qty) &&
    qty > 0 &&
    qty <= INT4_MAX;

  return wholeQty && isWasteReason(reason) ? null : message;
}

/** One stock movement a status change makes, as the demo's `waste.status` moves it. */
export interface StatusMove {
  /** The sign the entry's quantity moves with: −1 takes it, +1 returns it. */
  sign: -1 | 1;
  type: StockMovementType;
}

/**
 * The demo's `waste.status` stock rule: leaving Approved returns the
 * entry's quantity (`WASTE_APPROVAL_CORRECTION`), reaching Approved takes
 * it (`WASTE`); any other change moves nothing. Null when nothing moves.
 */
export function statusMove(
  from: WasteStatus,
  to: WasteStatus,
): StatusMove | null {
  if (from === WasteStatus.APPROVED && to !== WasteStatus.APPROVED) {
    return { sign: 1, type: StockMovementType.WASTE_APPROVAL_CORRECTION };
  }

  if (from !== WasteStatus.APPROVED && to === WasteStatus.APPROVED) {
    return { sign: -1, type: StockMovementType.WASTE };
  }

  return null;
}

/** The Waste Records screen's three views. */
export const WASTE_VIEWS = ['PENDING', 'HISTORY', 'ALL'] as const;

export type WasteView = (typeof WASTE_VIEWS)[number];
