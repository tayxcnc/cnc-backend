import {
  StaffRole,
  StockLocation,
  StockRequestStatus,
} from '../../generated/cnc-client';
import { INT4_MAX } from '../prisma/int4';
import { issueWithinRequestMessage } from './stock-messages';

/**
 * The stock request rules (plan §4.6, §7.6), pure, from the demo's
 * `request.create`, `request.issue` and `request.reject`
 * (`staff/lib/domain.ts`), so each is unit-tested without a database.
 */

/** The two locations a request is for: the Store issues, never asks. */
export const REQUEST_LOCATIONS = [
  StockLocation.KITCHEN,
  StockLocation.BAR,
] as const;

/** The statuses a request can still be issued or rejected in. */
export const OPEN_REQUEST_STATUSES: readonly StockRequestStatus[] = [
  StockRequestStatus.PENDING,
  StockRequestStatus.PARTIALLY_ISSUED,
];

/**
 * Where a request is for, as the demo's `request.create` decides it: the
 * Kitchen for a Kitchen user, the Bar for a Bartender or a Cashier
 * (whatever they sent: the screen offers them no choice), and for a
 * manager the location they chose. Null when that is not the Kitchen or
 * the Bar ("Choose Kitchen or Bar.").
 */
export function requestLocationFor(
  role: StaffRole,
  chosen: StockLocation | undefined,
): StockLocation | null {
  if (role === StaffRole.KITCHEN) return StockLocation.KITCHEN;

  if (role === StaffRole.BARTENDER || role === StaffRole.CASHIER) {
    return StockLocation.BAR;
  }

  return chosen !== undefined &&
    (REQUEST_LOCATIONS as readonly StockLocation[]).includes(chosen)
    ? chosen
    : null;
}

/** Whether a request can still be issued or rejected. */
export function isOpenRequest(status: StockRequestStatus): boolean {
  return OPEN_REQUEST_STATUSES.includes(status);
}

/**
 * The demo's check on an issue's packs: a whole number above zero and no
 * more than the request still wants, refused with "Enter a whole number of
 * <pack>s within the remaining request.". The units it puts at the
 * destination (packs × How Many in One) must also fit an `Int` column; a
 * larger figure would reach Postgres as a 500, so it is refused with the
 * same sentence. Null when the packs are good.
 */
export function issueProblem(
  qty: unknown,
  request: { qtyPacks: number; issuedPacks: number },
  item: { pack: string; factor: number },
): string | null {
  const remaining = request.qtyPacks - request.issuedPacks;
  const good =
    typeof qty === 'number' &&
    Number.isInteger(qty) &&
    qty > 0 &&
    qty <= remaining &&
    qty * item.factor <= INT4_MAX;

  return good ? null : issueWithinRequestMessage(item.pack);
}

/** The status after packs are sent: Issued once all of them are. */
export function statusAfterIssue(
  qtyPacks: number,
  issuedPacks: number,
): StockRequestStatus {
  return issuedPacks === qtyPacks
    ? StockRequestStatus.ISSUED
    : StockRequestStatus.PARTIALLY_ISSUED;
}
