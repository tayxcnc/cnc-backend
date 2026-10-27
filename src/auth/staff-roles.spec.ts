import { StaffRole } from '../../generated/cnc-client';
import {
  isManager,
  isOwner,
  ROLE_REFUSED_MESSAGE,
  roleMayRun,
} from './staff-roles';

describe('staff roles', () => {
  const ALL = Object.values(StaffRole);

  it('counts the Owner and Managers as managers, and nobody else', () => {
    expect(ALL.filter(isManager).sort()).toEqual(['MANAGER', 'OWNER']);
  });

  it('counts only the Owner as the Owner', () => {
    expect(ALL.filter(isOwner)).toEqual(['OWNER']);
  });

  it('lets managers run every restricted command, as requireRole does', () => {
    for (const allowed of [[], [StaffRole.CASHIER], [StaffRole.KITCHEN]]) {
      expect(roleMayRun(StaffRole.OWNER, allowed)).toBe(true);
      expect(roleMayRun(StaffRole.MANAGER, allowed)).toBe(true);
    }
  });

  it('reads an empty list as managers only', () => {
    const others = ALL.filter((role) => !isManager(role));

    expect(others).toHaveLength(6);
    for (const role of others) expect(roleMayRun(role, [])).toBe(false);
  });

  it('lets a listed role through and refuses an unlisted one', () => {
    const allowed = [StaffRole.CASHIER, StaffRole.BARTENDER];

    expect(roleMayRun(StaffRole.CASHIER, allowed)).toBe(true);
    expect(roleMayRun(StaffRole.BARTENDER, allowed)).toBe(true);
    expect(roleMayRun(StaffRole.WAITER, allowed)).toBe(false);
  });

  it("keeps the demo's refusal byte for byte", () => {
    expect(ROLE_REFUSED_MESSAGE).toBe(
      'Your current staff role cannot perform this action.',
    );
  });
});
