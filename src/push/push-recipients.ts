import type { Prisma, StaffRole } from '../../generated/cnc-client';
import { MANAGER_ROLES } from '../auth/staff-roles';
import { roleReceives, type StaffPushEvent } from './push-catalogue';

/** How long an open shift counts as being on duty (D8). */
export const ON_DUTY_WITHIN_MS = 16 * 60 * 60 * 1000;

/** A transaction's client, holding what the recipient reads read. */
export type RecipientReader = Pick<
  Prisma.TransactionClient,
  'staff' | 'attendanceRecord'
>;

/** Who a staff push is for, before the audience and page rules. */
export interface StaffRecipientSelector {
  /**
   * D8's role chain over these roles: the active holders who are on duty,
   * else every active holder, else every active Owner and Manager. If the
   * restaurant scans attendance, people at home stay quiet; if it does not,
   * the push still reaches someone.
   */
  roles?: readonly StaffRole[];
  /**
   * Every active holder of these roles, on duty or not (a daily digest),
   * else every active Owner and Manager.
   */
  everyone?: readonly StaffRole[];
  /** Every active Owner and Manager, on duty or not. */
  managers?: true;
  /** Named people (a task's assignee), told whether or not on duty. */
  staffIds?: readonly string[];
  /** Whoever acted, or already knows: removed last, fallback included. */
  except?: readonly string[];
}

/** One recipient, and whether they are on duty (D6 holds the others). */
export interface StaffRecipient {
  id: string;
  onDuty: boolean;
}

/**
 * The staff a push of `event` goes to (C10, D8): the selector resolved
 * against live `Staff` rows, then kept to the active staff whose role is in
 * the event's audience **and** opens its page (`roleReceives`), less
 * `except`. Read in the event's transaction, one query after another
 * (*Data and migrations*: never two at once on one connection).
 *
 * On duty is an open shift (`timeOut` null) that began within the last 16
 * hours: a shift left open overnight by a forgotten scan does not keep its
 * owner "at work" for days.
 */
export async function staffRecipients(
  tx: RecipientReader,
  args: StaffRecipientSelector & { event: StaffPushEvent; now: Date },
): Promise<StaffRecipient[]> {
  const onDutySince = new Date(args.now.getTime() - ON_DUTY_WITHIN_MS);

  const onDuty = async (ids: string[]): Promise<Set<string>> => {
    if (ids.length === 0) return new Set();

    const open = await tx.attendanceRecord.findMany({
      where: {
        staffId: { in: ids },
        timeOut: null,
        timeIn: { gte: onDutySince },
      },
      select: { staffId: true },
    });

    return new Set(open.map(({ staffId }) => staffId));
  };

  const activeHolders = async (
    roles: readonly StaffRole[],
  ): Promise<string[]> =>
    roles.length === 0
      ? []
      : (
          await tx.staff.findMany({
            where: { role: { in: [...roles] }, isActive: true },
            select: { id: true },
            orderBy: { id: 'asc' },
          })
        ).map(({ id }) => id);

  const chosen = new Set<string>();
  const byRole =
    (args.roles?.length ?? 0) > 0 || (args.everyone?.length ?? 0) > 0;

  if (args.roles !== undefined && args.roles.length > 0) {
    const holders = await activeHolders(args.roles);
    const working = await onDuty(holders);
    const onDutyHolders = holders.filter((id) => working.has(id));

    for (const id of onDutyHolders.length > 0 ? onDutyHolders : holders) {
      chosen.add(id);
    }
  }

  if (args.everyone !== undefined) {
    for (const id of await activeHolders(args.everyone)) chosen.add(id);
  }

  if (args.managers === true || (byRole && chosen.size === 0)) {
    for (const id of await activeHolders(MANAGER_ROLES)) chosen.add(id);
  }

  for (const id of args.staffIds ?? []) chosen.add(id);

  if (chosen.size === 0) return [];

  // The live rows: a named person may be inactive, or hold a role the
  // event is not for.
  const rows = await tx.staff.findMany({
    where: { id: { in: [...chosen] }, isActive: true },
    select: { id: true, role: true },
    orderBy: { id: 'asc' },
  });
  const except = new Set(args.except ?? []);
  const kept = rows.filter(
    (row) => roleReceives(args.event, row.role) && !except.has(row.id),
  );
  const working = await onDuty(kept.map(({ id }) => id));

  return kept.map(({ id }) => ({ id, onDuty: working.has(id) }));
}
