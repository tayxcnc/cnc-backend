import { ForbiddenException, Injectable } from '@nestjs/common';
import { type Prisma, StaffRole } from '../../generated/cnc-client';
import { isManager, isOwner } from '../auth/staff-roles';
import { formatIsoDate } from '../common/calendar-date';
import { formatKoboShort } from '../common/money';
import { watToday } from '../common/wat';

/**
 * The Owner's money rules (plan §6.2, Q15 "Protecting the Money"): the
 * demo's `ownerOnly`, `withinLimit` and `notOwn` (`staff/lib/domain.ts`),
 * its Daily Approval Limit, and its `staff.save` rules for Manager and
 * Owner accounts and the last active Owner, on the server.
 *
 * Every refusal is 403 (A7) with the demo's sentence byte for byte; the
 * screens show it as it stands. The sentences are exported so a later
 * command and its tests name the same string instead of retyping it.
 *
 * The checks that read the database take the command's transaction client
 * and run inside it, so a refusal rolls the whole command back, and the
 * daily ledger row commits with the decision it counts or not at all.
 */

/** Who is acting: the live principal `CncStaffGuard` put on the request. */
export interface MoneyActor {
  /** Staff.id (A10): own-record checks and the ledger are by id. */
  id: string;
  role: StaffRole;
}

/** The transaction client a command runs in. */
type Tx = Prisma.TransactionClient;

/** The demo's `ownerOnly(what)` sentence: "Only the Owner can <what>." */
export function ownerOnlyMessage(what: string): string {
  return `Only the Owner can ${what}.`;
}

/** What `ownerOnly` guards, word for word from the demo's call sites. */
export const OWNER_ONLY_ACTIONS = {
  /** `order.reverse` (D35). */
  reverseBill: 'reverse a paid bill',
  /** `stock.adjust`. */
  correctStockBalance: 'correct a stock balance',
} as const;

/** `menu.save` by a manager naming a new price (C3-7). */
export const OWNER_ONLY_PRICE_MESSAGE = 'Only the Owner can change a price.';

/** `menu.save` by a manager creating an item (C3-7). */
export const OWNER_ONLY_NEW_MENU_ITEM_MESSAGE =
  'Only the Owner can add a menu item, because every item needs a price.';

/**
 * `settings.save` by a manager changing VAT, service, the deposit, a
 * delivery fee, the approval limit, or the daily limit or its switch (C3-7).
 */
export const OWNER_ONLY_SETTINGS_MESSAGE =
  'Only the Owner can change tax, service charge, delivery fees or the approval limits.';

/**
 * `staff.save` (and the admin reset) by a manager on a Manager or Owner
 * account, or making one.
 */
export const OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE =
  'Only the Owner can create or change Manager and Owner accounts.';

/** `staff.save` demoting or deactivating the last active Owner. */
export const LAST_ACTIVE_OWNER_MESSAGE = 'CNC needs at least one active Owner.';

/**
 * What a limited decision is called in its refusal, word for word from the
 * demo's `withinLimit` call sites.
 */
export const LIMITED_DECISIONS = {
  /** `order.discount`. */
  discount: 'This discount',
  /** `purchase.approve`, `purchase.edit`, `purchase.status` to Approved. */
  purchase: 'This purchase',
  /** `waste.approve`, `waste.edit`, `waste.status` to Approved. */
  writeOff: 'This write-off',
  /** `online.edit` and `online.cancel`. */
  onlineChange: 'This change to a paid online order',
  /** `online.balance`. */
  paymentCorrection: 'This payment correction',
} as const;

/** What `notOwn` names, word for word from the demo's call sites. */
export const OWN_RECORD_KINDS = {
  /** `request.issue`. */
  stockRequest: 'stock request',
  /** `purchase.approve`, `purchase.status` to Approved. */
  purchase: 'purchase',
  /** `waste.approve`, `waste.status` to Approved. */
  wasteEntry: 'waste entry',
} as const;

/** The per-decision refusal, as the demo words it. */
export function approvalLimitMessage(what: string, limitKobo: number): string {
  return (
    `${what} is above the Owner Approval Limit of ` +
    `${formatKoboShort(limitKobo)}. The Owner must approve it.`
  );
}

/** The daily refusal, as the demo words it. */
export function dailyLimitMessage(
  totalKobo: number,
  limitKobo: number,
): string {
  return (
    `This would take your approvals today to ${formatKoboShort(totalKobo)}, ` +
    `above the Daily Approval Limit of ${formatKoboShort(limitKobo)}. ` +
    `The Owner must approve it.`
  );
}

/** The own-record refusal, as the demo words it. */
export function ownRecordMessage(what: string): string {
  return (
    `You cannot approve a ${what} you created. ` +
    `The Owner or another manager must approve it.`
  );
}

/** One money decision checked by {@link MoneyControlService.withinLimit}. */
export interface LimitedDecision {
  /**
   * The amount the decision is worth, in kobo. Its size is checked against
   * the Owner Approval Limit; a refund is negative and counts by its size.
   */
  amountKobo: number;
  /** How the refusal names it: one of {@link LIMITED_DECISIONS}. */
  what: string;
  /**
   * True when the decision counts toward the Daily Approval Limit (the
   * demo's `count`): an approval, a discount, an online correction. An edit
   * of a pending record is checked against the per-decision limit only.
   */
  count?: boolean;
  /**
   * The amount that counts toward the day, when it differs from
   * `amountKobo`: a discount counts only its increase. Defaults to
   * `amountKobo`.
   */
  countedKobo?: number;
  /** The command, for the ledger row: `waste.approve`. */
  action: string;
  /** The record's human reference, for the ledger row: `W-000012`. */
  ref?: string | null;
  /** The instant of the decision, which fixes its business date. */
  at?: Date;
}

/** The settings the limits are read from, in the command's transaction. */
const LIMIT_SETTINGS_SELECT = {
  approvalLimitKobo: true,
  dailyLimitOn: true,
  dailyLimitKobo: true,
} as const;

/**
 * The advisory-lock namespaces, hashed into the first key of the two-key
 * form: the 64-bit and the two 32-bit key spaces never overlap, so these
 * cannot collide with a single-key lock such as the Owner seed's.
 */
const APPROVAL_LEDGER_LOCK = 'cnc:approval-ledger';
const ACTIVE_OWNERS_LOCK = 'cnc:active-owners';

@Injectable()
export class MoneyControlService {
  /**
   * The demo's `ownerOnly(what)`: 403 "Only the Owner can <what>." unless
   * the actor is the Owner. Use {@link OWNER_ONLY_ACTIONS} for `what`.
   */
  ownerOnly(actor: MoneyActor, what: string): void {
    this.requireOwner(actor, ownerOnlyMessage(what));
  }

  /**
   * An Owner-only rule whose sentence is not the `ownerOnly` form: a price
   * ({@link OWNER_ONLY_PRICE_MESSAGE}), a new menu item, the Owner-only
   * settings keys.
   */
  requireOwner(actor: MoneyActor, message: string): void {
    if (!isOwner(actor.role)) {
      throw new ForbiddenException(message);
    }
  }

  /**
   * The demo's `staff.save` account rule: only the Owner creates a Manager
   * or Owner account, or changes one (its role, status, details or
   * password), or makes someone a Manager or Owner.
   *
   * `currentRole` is the account's role now (absent for a new account);
   * `newRole` the role the change gives it (absent when the role is not
   * being set, as in a password reset).
   */
  mayChangeAccount(
    actor: MoneyActor,
    account: { currentRole?: StaffRole | null; newRole?: StaffRole | null },
  ): void {
    if (isOwner(actor.role)) return;

    const touchesManager =
      (account.currentRole != null && isManager(account.currentRole)) ||
      (account.newRole != null && isManager(account.newRole));

    if (touchesManager) {
      throw new ForbiddenException(OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE);
    }
  }

  /**
   * The demo's `notOwn(by, what)`: a manager may not approve a record they
   * created. The Owner is exempt, and a record with no creator passes, as
   * in the demo. By staff id (A10), never by name.
   */
  notOwn(
    actor: MoneyActor,
    createdById: string | null | undefined,
    what: string,
  ): void {
    if (isOwner(actor.role)) return;

    if (createdById != null && createdById === actor.id) {
      throw new ForbiddenException(ownRecordMessage(what));
    }
  }

  /**
   * The demo's `withinLimit`: the Owner Approval Limit per decision, then
   * the Daily Approval Limit per manager per business date, with the ledger.
   *
   * 1. The Owner is exempt from both and is never recorded.
   * 2. The decision's size above `approvalLimitKobo` is refused.
   * 3. A decision that does not count, or counts nothing, stops there.
   * 4. Otherwise the manager's ledger for the day is locked
   *    (`pg_advisory_xact_lock` on the manager and the date), summed, and,
   *    while the daily limit is on, a total above `dailyLimitKobo` is
   *    refused.
   * 5. The counted amount is written to the ledger, **whether or not the
   *    daily limit is on** (D36): switching it back on mid-day counts the
   *    day's decisions already made.
   *
   * Run it inside the command's transaction, before the command's own
   * writes: a refusal rolls everything back, and the lock is held until the
   * command commits, so a second approval by the same manager waits and
   * then sees this one in the sum.
   *
   * The limits are read from the settings row in the same transaction, so
   * a lowered limit applies to the next decision at once.
   */
  async withinLimit(
    tx: Tx,
    actor: MoneyActor,
    decision: LimitedDecision,
  ): Promise<void> {
    if (isOwner(actor.role)) return;

    const settings = await tx.settings.findUnique({
      where: { singleton: true },
      select: LIMIT_SETTINGS_SELECT,
    });

    if (settings === null) {
      // A database without its settings row was never seeded; refusing every
      // decision with a 403 would blame the manager for it.
      throw new Error(
        'The settings row is missing. Run `npm run db:seed` on this database.',
      );
    }

    const size = Math.abs(decision.amountKobo);

    if (size > settings.approvalLimitKobo) {
      throw new ForbiddenException(
        approvalLimitMessage(decision.what, settings.approvalLimitKobo),
      );
    }

    const counted = Math.abs(decision.countedKobo ?? decision.amountKobo);

    if (decision.count !== true || counted === 0) return;

    const businessDate = watToday(decision.at ?? new Date());
    // The date travels as `YYYY-MM-DD` text, never as a Date parameter: a
    // timestamp cast to `date` is read in the session's time zone.
    const isoDate = formatIsoDate(businessDate);

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      hashtext(${APPROVAL_LEDGER_LOCK}),
      hashtext(${`${actor.id}:${isoDate}`}))`;

    if (settings.dailyLimitOn) {
      // A bigint sum (plan §10): with the limit off a day's total is
      // unbounded, and an Int `_sum` overflows at about ₦21 million.
      const [row] = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT COALESCE(SUM("amountKobo"), 0)::bigint AS "total"
          FROM "ApprovalLedger"
         WHERE "staffId" = ${actor.id}
           AND "businessDate" = ${isoDate}::date`;
      const total = Number(row.total) + counted;

      if (total > settings.dailyLimitKobo) {
        throw new ForbiddenException(
          dailyLimitMessage(total, settings.dailyLimitKobo),
        );
      }
    }

    await tx.approvalLedger.create({
      data: {
        businessDate,
        staffId: actor.id,
        amountKobo: counted,
        action: decision.action,
        ref: decision.ref ?? null,
      },
    });
  }

  /**
   * The last-Owner rule (plan §11, the demo's `staff.save`): an Owner
   * account may be demoted or deactivated only while another active Owner
   * exists, so CNC always has someone who can approve above the limits.
   * An Owner may step down when there is a second one; TAY's self-lockout
   * rule is not copied.
   *
   * As in the demo, the rule applies whenever the account is an Owner now
   * and the change leaves it anything but an active Owner.
   *
   * Every such change takes one advisory lock before counting, so two
   * Owners demoting each other at the same moment cannot both see the
   * other still active: the second waits, then counts after the first
   * commits.
   */
  async keepsAnActiveOwner(
    tx: Tx,
    change: {
      staffId: string;
      currentRole: StaffRole;
      newRole: StaffRole;
      newIsActive: boolean;
    },
  ): Promise<void> {
    if (change.currentRole !== StaffRole.OWNER) return;
    if (change.newRole === StaffRole.OWNER && change.newIsActive) return;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ACTIVE_OWNERS_LOCK}), 0)`;

    const others = await tx.staff.count({
      where: {
        role: StaffRole.OWNER,
        isActive: true,
        id: { not: change.staffId },
      },
    });

    if (others === 0) {
      throw new ForbiddenException(LAST_ACTIVE_OWNER_MESSAGE);
    }
  }
}
