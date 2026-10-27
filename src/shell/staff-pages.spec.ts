import { StaffRole } from '../../generated/cnc-client';
import { pagesFor, STAFF_PAGES } from './staff-pages';

/**
 * The staff app's `canAccess` (`staff/lib/domain.ts`), restated here as the
 * demo wrote it, so `pagesFor` is checked against the source rather than
 * against itself.
 */
const DEMO_PAGES: Record<string, string[]> = {
  RECEPTION: ['overview', 'reception', 'maintenance', 'tasks'],
  CASHIER: ['overview', 'pos', 'online', 'reports', 'tasks'],
  WAITER: ['overview', 'pos'],
  BARTENDER: ['overview', 'pos', 'inventory', 'waste'],
  KITCHEN: ['overview', 'kitchen', 'inventory', 'waste', 'tasks'],
  STOREKEEPER: [
    'overview',
    'inventory',
    'purchasing',
    'waste',
    'tasks',
    'vendors',
  ],
};

function demoCanAccess(role: StaffRole, page: string): boolean {
  if (page === 'myid') return true;
  if (role === StaffRole.OWNER || role === StaffRole.MANAGER) return true;

  return (DEMO_PAGES[role] ?? []).includes(page);
}

describe('pagesFor', () => {
  it('lists the 19 screens in sidebar order', () => {
    expect(STAFF_PAGES).toHaveLength(19);
    expect(STAFF_PAGES[0]).toBe('overview');
    expect(STAFF_PAGES[STAFF_PAGES.length - 1]).toBe('myid');
  });

  it.each(Object.values(StaffRole))(
    'gives %s exactly the screens the demo’s canAccess allows',
    (role) => {
      expect(pagesFor(role)).toEqual(
        STAFF_PAGES.filter((page) => demoCanAccess(role, page)),
      );
    },
  );

  it('opens every screen to the Owner and Managers, and My Staff ID to all', () => {
    expect(pagesFor(StaffRole.OWNER)).toEqual([...STAFF_PAGES]);
    expect(pagesFor(StaffRole.MANAGER)).toEqual([...STAFF_PAGES]);

    for (const role of Object.values(StaffRole)) {
      expect(pagesFor(role)).toContain('myid');
    }
  });

  it('keeps Reception off Online Orders, as the demo’s own test does', () => {
    expect(pagesFor(StaffRole.RECEPTION)).not.toContain('online');
  });
});
