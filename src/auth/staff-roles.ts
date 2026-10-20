import { StaffRole } from '../../generated/cnc-client';

/**
 * Who counts as a manager, and who as the Owner: the demo's `isManager` and
 * `isOwner` (`staff/lib/domain.ts`), on the server.
 *
 * In the demo the Owner holds every manager permission ("The owner has every
 * manager permission for now"), and the Owner-only rules (prices, the
 * approval limits, reversals) are layered on top by `MoneyControlService`
 * (C3-4). Plan §6.2 reads every row the same way: "managers always pass
 * unless the row says otherwise". One definition, so the guard, the money
 * rules and the staff rules can never disagree on who a manager is.
 */
export const MANAGER_ROLES: readonly StaffRole[] = [
  StaffRole.OWNER,
  StaffRole.MANAGER,
];

/** The demo's `isManager`: the Owner or a Manager. */
export function isManager(role: StaffRole): boolean {
  return MANAGER_ROLES.includes(role);
}

/** The demo's `isOwner`. */
export function isOwner(role: StaffRole): boolean {
  return role === StaffRole.OWNER;
}

/**
 * The demo's `requireRole` refusal (`domain.ts`), byte for byte (A7): what a
 * staff member sees when their role may not run a command.
 */
export const ROLE_REFUSED_MESSAGE =
  'Your current staff role cannot perform this action.';

/**
 * The demo's `requireRole(roles)`: managers always pass, and so does any role
 * in the list. An empty list therefore means managers only, which is how the
 * demo spells "M" (`requireRole([])`).
 */
export function roleMayRun(
  role: StaffRole,
  allowed: readonly StaffRole[],
): boolean {
  return isManager(role) || allowed.includes(role);
}
