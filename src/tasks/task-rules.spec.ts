import { StaffRole, TaskType } from '../../generated/cnc-client';
import {
  ASSIGNED_ONLY_MESSAGE,
  MANAGER_DETAILS_MESSAGE,
  MANAGER_LINKS_MESSAGE,
  MANAGER_REASSIGN_MESSAGE,
} from './task-messages';
import {
  isAssignable,
  linksFor,
  mayRaiseTo,
  nonManagerSaveProblem,
  seesTask,
  type StoredTask,
  visibleTasks,
} from './task-rules';

const reception = { id: 'reception', role: StaffRole.RECEPTION };
const manager = { id: 'manager', role: StaffRole.MANAGER };

/** A Maintenance task assigned to Reception. */
const stored: StoredTask = {
  title: 'Follow up repair',
  type: TaskType.MAINTENANCE,
  assignedToId: 'reception',
  purchaseId: null,
  maintenanceId: 'repair-1',
};

describe('task rules', () => {
  describe('isAssignable', () => {
    it('never gives a task to a Waiter or a Bartender, or to anyone inactive', () => {
      expect(isAssignable({ isActive: true, role: StaffRole.WAITER })).toBe(
        false,
      );
      expect(isAssignable({ isActive: true, role: StaffRole.BARTENDER })).toBe(
        false,
      );
      expect(isAssignable({ isActive: false, role: StaffRole.KITCHEN })).toBe(
        false,
      );

      for (const role of [
        StaffRole.OWNER,
        StaffRole.MANAGER,
        StaffRole.RECEPTION,
        StaffRole.CASHIER,
        StaffRole.KITCHEN,
        StaffRole.STOREKEEPER,
      ]) {
        expect(isAssignable({ isActive: true, role })).toBe(true);
      }
    });
  });

  describe('mayRaiseTo', () => {
    it('staff can raise a task to a manager or themselves, not to other staff', () => {
      expect(mayRaiseTo(reception, manager)).toBe(true);
      expect(mayRaiseTo(reception, { id: 'o', role: StaffRole.OWNER })).toBe(
        true,
      );
      expect(mayRaiseTo(reception, reception)).toBe(true);
      expect(
        mayRaiseTo(reception, { id: 'store', role: StaffRole.STOREKEEPER }),
      ).toBe(false);
      expect(mayRaiseTo(reception, null)).toBe(false);
    });
  });

  describe('nonManagerSaveProblem', () => {
    const save = {
      title: stored.title,
      type: stored.type,
      assignedToId: stored.assignedToId,
      maintenanceId: 'repair-1',
    };

    it('lets the assignee save the status of their own task', () => {
      expect(nonManagerSaveProblem(reception, stored, save)).toBeNull();
      expect(
        nonManagerSaveProblem(reception, stored, {
          title: stored.title,
          type: stored.type,
        }),
      ).toBeNull();
    });

    it('refuses anyone else, and then any change but the status, in the demo’s order', () => {
      expect(
        nonManagerSaveProblem(
          { id: 'kitchen', role: StaffRole.KITCHEN },
          stored,
          save,
        ),
      ).toBe(ASSIGNED_ONLY_MESSAGE);
      expect(
        nonManagerSaveProblem(reception, stored, {
          ...save,
          title: 'Other',
          assignedToId: 'manager',
        }),
      ).toBe(MANAGER_DETAILS_MESSAGE);
      expect(
        nonManagerSaveProblem(reception, stored, {
          ...save,
          assignedToId: 'manager',
        }),
      ).toBe(MANAGER_REASSIGN_MESSAGE);
      expect(
        nonManagerSaveProblem(reception, stored, {
          ...save,
          maintenanceId: 'OTHER',
        }),
      ).toBe(MANAGER_LINKS_MESSAGE);
      expect(
        nonManagerSaveProblem(reception, stored, {
          ...save,
          type: TaskType.GENERAL,
        }),
      ).toBe(MANAGER_LINKS_MESSAGE);
    });

    it('never refuses a manager', () => {
      expect(
        nonManagerSaveProblem(manager, stored, {
          title: 'New',
          type: TaskType.GENERAL,
          assignedToId: 'someone',
        }),
      ).toBeNull();
    });
  });

  describe('linksFor', () => {
    it('keeps a non-manager’s links as they are', () => {
      expect(
        linksFor(reception, stored, {
          title: stored.title,
          type: stored.type,
        }),
      ).toEqual({ purchaseId: null, maintenanceId: 'repair-1' });
    });

    it('links only the record the type names, keeping the stored one when none is sent', () => {
      expect(
        linksFor(manager, null, {
          title: 'Buy stock',
          type: TaskType.PURCHASE,
          purchaseId: 'p1',
          maintenanceId: 'm1',
        }),
      ).toEqual({ purchaseId: 'p1', maintenanceId: null });
      expect(
        linksFor(manager, stored, {
          title: stored.title,
          type: TaskType.MAINTENANCE,
        }),
      ).toEqual({ purchaseId: null, maintenanceId: 'repair-1' });
      expect(
        linksFor(manager, stored, {
          title: stored.title,
          type: TaskType.GENERAL,
          maintenanceId: 'repair-1',
        }),
      ).toEqual({ purchaseId: null, maintenanceId: null });
    });
  });

  describe('visibleTasks and seesTask (plan §6.1)', () => {
    it('shows managers every task', () => {
      expect(visibleTasks(manager)).toEqual({});
      expect(
        seesTask(manager, {
          assignedToId: 'x',
          raisedById: 'y',
          automatic: true,
        }),
      ).toBe(true);
    });

    it('shows anyone else the tasks assigned to them and those they raised, not automatic ones they caused', () => {
      expect(visibleTasks(reception)).toEqual({
        OR: [
          { assignedToId: 'reception' },
          { raisedById: 'reception', automatic: false },
        ],
      });
      expect(
        seesTask(reception, {
          assignedToId: 'reception',
          raisedById: 'manager',
          automatic: true,
        }),
      ).toBe(true);
      expect(
        seesTask(reception, {
          assignedToId: 'manager',
          raisedById: 'reception',
          automatic: false,
        }),
      ).toBe(true);
      expect(
        seesTask(reception, {
          assignedToId: 'manager',
          raisedById: 'reception',
          automatic: true,
        }),
      ).toBe(false);
      expect(
        seesTask(reception, {
          assignedToId: 'manager',
          raisedById: 'kitchen',
          automatic: false,
        }),
      ).toBe(false);
    });
  });
});
