import { StaffRole } from '../../generated/cnc-client';
import { isManager } from '../auth/staff-roles';

/**
 * The staff app's screens, by their hash keys, in its sidebar order
 * (`staff/components/cnc/workspace.tsx`, `nav`), plus My Staff ID: the 19
 * screens of plan §2.
 */
export const STAFF_PAGES = [
  'overview',
  'reception',
  'pos',
  'kitchen',
  'online',
  'inventory',
  'purchasing',
  'waste',
  'approvals',
  'reports',
  'tasks',
  'maintenance',
  'vendors',
  'people',
  'attendance',
  'menu',
  'activity',
  'settings',
  'myid',
] as const;

export type StaffPage = (typeof STAFF_PAGES)[number];

/**
 * The screens each role other than the Owner and Managers may open: the
 * demo's `canAccess` table (`staff/lib/domain.ts`), byte for byte in its
 * keys. My Staff ID is open to everyone and is added by `pagesFor`.
 */
const ROLE_PAGES: Readonly<Record<StaffRole, readonly StaffPage[]>> = {
  [StaffRole.OWNER]: STAFF_PAGES,
  [StaffRole.MANAGER]: STAFF_PAGES,
  [StaffRole.RECEPTION]: ['overview', 'reception', 'maintenance', 'tasks'],
  [StaffRole.CASHIER]: ['overview', 'pos', 'online', 'reports', 'tasks'],
  [StaffRole.WAITER]: ['overview', 'pos'],
  [StaffRole.BARTENDER]: ['overview', 'pos', 'inventory', 'waste'],
  [StaffRole.KITCHEN]: ['overview', 'kitchen', 'inventory', 'waste', 'tasks'],
  [StaffRole.STOREKEEPER]: [
    'overview',
    'inventory',
    'purchasing',
    'waste',
    'tasks',
    'vendors',
  ],
};

/**
 * The demo's `canAccess(role, page)` as a list: the screens a role may
 * open, in sidebar order. Managers and the Owner open every screen; every
 * role opens My Staff ID.
 *
 * This is what the shell shows, not the security boundary: every route
 * checks the role again (plan §6: hiding a button is not security).
 */
export function pagesFor(role: StaffRole): StaffPage[] {
  if (isManager(role)) return [...STAFF_PAGES];

  const allowed = new Set<StaffPage>([...ROLE_PAGES[role], 'myid']);

  return STAFF_PAGES.filter((page) => allowed.has(page));
}
