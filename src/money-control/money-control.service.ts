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
 * `settings.save` by a manager changing one of the six booking and ordering
 * times (last arrival, last order slot, slot step, the three lead times),
 * and `PUT /staff/opening-hours` by a manager (C3-7). Owner-only by Q29's
 * default, "like VAT and fees, because the owner confirmed them". The demo
 * had neither the times nor editable hours, so it has no sentence; this one
 * follows the form of the settings sentence above.
 */
export const OWNER_ONLY_TIMES_MESSAGE =
  'Only the Owner can change the opening hours or the booking and ordering times.';

/**
 * `staff.save` (and the admin reset) by a manager on a Manager or Owner
 * account, or making one.
 */
export const OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE =
  'Only the Owner can create or change Manager and Owner accounts.';

/**
 * `GET /staff/people/:id/card` by a manager for another Manager's or the
 * Owner's card. New: the demo showed every card to every manager, but the
 * card's QR code is the person's attendance credential (C5-7), and a
 * Manager or Owner account is the Owner's to manage (plan §5.4), its ID
 * reissued only by the Owner. The sentence follows the account sentence's
 * form.
 */
export const OWNER_ONLY_MANAGER_CARD_MESSAGE =
  'Only the Owner can open a Manager or Owner Staff ID.';

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
  /**
   * `stock.count` (C4-2), by Q28's default: a count whose differences,
   * valued as waste is valued, exceed the Owner Approval Limit needs the
   * Owner, and every count with a valued difference counts toward the
   * Daily Approval Limit. The demo had no limit on a count, so this name is
   * new and follows the form of the others.
   */
  stockCount: 'This stock count',
} as const;

/**
 * What `notOwn` names, word for word from the demo's call sites; also what
 * `notOwnCorrection` names.
 */
export const OWN_RECORD_KINDS = {
  /** `request.issue`. */
  stockRequest: 'stock request',
  /**
   * `purchase.approve`, `purchase.status` to Approved; `purchase.edit` of an
   * approved purchase (`notOwnCorrection`).
   */
  purchase: 'purchase',
  /**
   * `waste.approve`, `waste.status` to Approved; `waste.edit` of an approved
   * entry (`notOwnCorrection`).
   */
  wasteEntry: 'waste entry',
} as const;

/**
 * What a correction of an approved record adds to it, in kobo: the new
 * value less the old when that is positive, else nothing. `order.discount`
 * counts this toward the Daily Approval Limit ("the increase only"), and
 * by the founder's decision of 2026-10-22 so do `waste.edit` and
 * `purchase.edit` of an approved record: lowering a decision already
 * counted adds nothing to the day, and raising it is a fresh decision of
 * the difference.
 */
export function increaseKobo(beforeKobo: number, afterKobo: number): number {
  return Math.max(0, afterKobo - beforeKobo);
}

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

/**
 * The refusal of a manager correcting an approved record they created
 * (`waste.edit`, `purchase.edit`). New, by the founder's decision of
 * 2026-10-22: the demo let a correction through on the limit alone, so a
 * manager could raise their own write-off or requisition once a colleague
 * had approved it. The sentence follows the own-record sentence's form.
 */
export function ownRecordCorrectionMessage(what: string): string {
  return (
    `You cannot change an approved ${what} you created. ` +
    `The Owner or another manager must change it.`
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
   * demo's `count`): an approval, a discount, an online correction, a
   * correction of an approved write-off or purchase. An edit of a pending
   * record is checked against the per-decision limit only.
   */
  count?: boolean;
  /**
   * The amount that counts toward the day, when it differs from
   * `amountKobo`: a discount, or a correction of an approved record, counts
   * only its increase ({@link increaseKobo}). Defaults to `amountKobo`.
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

/** What the limits are read through: the pool, or a command's transaction. */
type LimitReader = Pick<Tx, 'settings' | '$queryRaw'>;

/**
 * Where one person stands against the limits today: the limits as set, and
 * what the ledger holds for them on this business date. A read that shows
 * whether an approval would pass (the Approvals screen, C5-8) predicts it
 * from this, through {@link approvalRefusal}.
 */
export interface ApprovalStanding {
  approvalLimitKobo: number;
  dailyLimitOn: boolean;
  dailyLimitKobo: number;
  /** The ledger's total for the person on the business date. */
  approvedTodayKobo: number;
}

/** One approval {@link approvalRefusal} predicts. */
export interface PredictedApproval {
  /** What the approval would be judged on, in kobo; counted toward the day. */
  amountKobo: number;
  /** How a limit refusal names it: one of {@link LIMITED_DECISIONS}. */
  what: string;
  /** Who raised the record, for the own-record rule. */
  createdById: string | null | undefined;
  /** How the own-record refusal names it: one of {@link OWN_RECORD_KINDS}. */
  ownKind: string;
}

/**
 * The sentence an approval by `actor` would be refused with now, or null
 * when it would pass: `withinLimit` with the decision counted toward the
 * day, then `notOwn`, in that order (the demo's order on every approval).
 * A pure function of the standing, so a read can show it without taking
 * the ledger's lock; the command still decides under the lock, and a read
 * that raced another approval may be one decision behind.
 */
export function approvalRefusal(
  actor: MoneyActor,
  standing: ApprovalStanding,
  approval: PredictedApproval,
): string | null {
  if (isOwner(actor.role)) return null;

  const size = Math.abs(approval.amountKobo);

  if (size > standing.approvalLimitKobo) {
    return approvalLimitMessage(approval.what, standing.approvalLimitKobo);
  }

  if (size !== 0 && standing.dailyLimitOn) {
    const total = standing.approvedTodayKobo + size;

    if (total > standing.dailyLimitKobo) {
      return dailyLimitMessage(total, standing.dailyLimitKobo);
    }
  }

  if (approval.createdById != null && approval.createdById === actor.id) {
    return ownRecordMessage(approval.ownKind);
  }

  return null;
}

/** The settings row, or the seeding error every limit check raises. */
async function limitSettings(client: Pick<Tx, 'settings'>) {
  const settings = await client.settings.findUnique({
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

  return settings;
}

/**
 * One person's ledger total for one business date (`YYYY-MM-DD`). A bigint
 * sum (plan §10): with the limit off a day's total is unbounded, and an
 * Int `_sum` overflows at about ₦21 million.
 */
async function ledgerTotalKobo(
  client: Pick<Tx, '$queryRaw'>,
  staffId: string,
  isoDate: string,
): Promise<number> {
  const [row] = await client.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM("amountKobo"), 0)::bigint AS "total"
      FROM "ApprovalLedger"
     WHERE "staffId" = ${staffId}
       AND "businessDate" = ${isoDate}::date`;

  return Number(row.total);
}

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
   * Whose Staff ID card a manager may open: their own, and any account that
   * is not a Manager's or the Owner's. The Owner opens every card.
   */
  mayReadCard(actor: MoneyActor, card: { id: string; role: StaffRole }): void {
    if (card.id === actor.id || isOwner(actor.role)) return;

    if (isManager(card.role)) {
      throw new ForbiddenException(OWNER_ONLY_MANAGER_CARD_MESSAGE);
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
    this.refuseOwn(actor, createdById, ownRecordMessage(what));
  }

  /**
   * `notOwn` for a correction of an approved record (the founder's decision
   * of 2026-10-22): a manager may not change an approved write-off or
   * purchase they created, in either direction, with
   * {@link ownRecordCorrectionMessage}. The Owner is exempt and a record
   * with no creator passes, as `notOwn` has them. A record still Pending
   * is not checked: it awaits someone else's approval anyway.
   */
  notOwnCorrection(
    actor: MoneyActor,
    createdById: string | null | undefined,
    what: string,
  ): void {
    this.refuseOwn(actor, createdById, ownRecordCorrectionMessage(what));
  }

  /** The own-record rule both commands share: by staff id, the Owner exempt. */
  private refuseOwn(
    actor: MoneyActor,
    createdById: string | null | undefined,
    message: string,
  ): void {
    if (isOwner(actor.role)) return;

    if (createdById != null && createdById === actor.id) {
      throw new ForbiddenException(message);
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

    const settings = await limitSettings(tx);

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
      const total = (await ledgerTotalKobo(tx, actor.id, isoDate)) + counted;

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
   * Where `actor` stands against the limits on the business date of `at`
   * (now by default): the limits as set and the ledger's total for them,
   * read without the ledger's lock (a read decides nothing). The Owner is
   * never recorded, so their total is always zero.
   */
  async standing(
    client: LimitReader,
    actor: MoneyActor,
    at: Date = new Date(),
  ): Promise<ApprovalStanding> {
    const settings = await limitSettings(client);

    return {
      approvalLimitKobo: settings.approvalLimitKobo,
      dailyLimitOn: settings.dailyLimitOn,
      dailyLimitKobo: settings.dailyLimitKobo,
      approvedTodayKobo: await ledgerTotalKobo(
        client,
        actor.id,
        formatIsoDate(watToday(at)),
      ),
    };
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
