import {
  AssetStatus,
  MaintenanceStatus,
  TaskType,
} from '../../generated/cnc-client';
import { INT4_MAX } from '../prisma/int4';
import {
  ASSET_FIELDS_MESSAGE,
  REPAIR_DESCRIPTION_COST_MESSAGE,
  REPAIR_TASK_TYPE_MESSAGE,
  TASK_HAS_REPAIR_MESSAGE,
} from './asset-messages';
import {
  assetFieldsProblem,
  assetStatusForRepair,
  followUpTitle,
  isRepairStatus,
  isResolved,
  repairFieldsProblem,
  repairTaskProblem,
  resolvedOnFor,
} from './maintenance-rules';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('assetFieldsProblem', () => {
  it('passes a tag, a name and a whole quantity above zero', () => {
    expect(assetFieldsProblem('AC1', 'Lounge air conditioner', 1)).toBeNull();
  });

  it('answers the demo’s one sentence for any of the three', () => {
    for (const [tag, name, quantity] of [
      ['', 'Chairs', 1],
      ['  ', 'Chairs', 1],
      ['CHR1', ' ', 1],
      ['CHR1', 'Chairs', 0],
      ['CHR1', 'Chairs', 1.5],
      ['CHR1', 'Chairs', '28'],
      ['CHR1', 'Chairs', INT4_MAX + 1],
      [undefined, undefined, undefined],
    ] as const) {
      expect(assetFieldsProblem(tag, name, quantity)).toBe(
        ASSET_FIELDS_MESSAGE,
      );
    }
  });

  it('names a tag or name that is too long', () => {
    expect(assetFieldsProblem('T'.repeat(41), 'Chairs', 1)).toBe(
      'tag must be 40 characters or fewer.',
    );
    expect(assetFieldsProblem('CHR1', 'N'.repeat(121), 1)).toBe(
      'name must be 120 characters or fewer.',
    );
  });
});

describe('repairFieldsProblem', () => {
  it('passes a description and a whole cost from zero', () => {
    expect(repairFieldsProblem('Screen flickers', 0)).toBeNull();
    expect(repairFieldsProblem('Replaced cable', 1_250_000)).toBeNull();
  });

  it('answers the demo’s one sentence for a blank description or a bad cost', () => {
    for (const [description, cost] of [
      ['', 0],
      ['Fix', -1],
      ['Fix', 10.5],
      ['Fix', '0'],
      ['Fix', undefined],
    ] as const) {
      expect(repairFieldsProblem(description, cost)).toBe(
        REPAIR_DESCRIPTION_COST_MESSAGE,
      );
    }
  });
});

describe('repair statuses', () => {
  it('knows the four statuses and which close a repair', () => {
    expect(isRepairStatus('IN_PROGRESS')).toBe(true);
    expect(isRepairStatus('In Progress')).toBe(false);
    expect(isResolved(MaintenanceStatus.FIXED)).toBe(true);
    expect(isResolved(MaintenanceStatus.NOT_FIXED)).toBe(true);
    expect(isResolved(MaintenanceStatus.PENDING)).toBe(false);
  });

  it('moves the asset as the demo does', () => {
    expect(assetStatusForRepair(MaintenanceStatus.PENDING)).toBe(
      AssetStatus.UNDER_REPAIR,
    );
    expect(assetStatusForRepair(MaintenanceStatus.IN_PROGRESS)).toBe(
      AssetStatus.UNDER_REPAIR,
    );
    expect(assetStatusForRepair(MaintenanceStatus.FIXED)).toBe(
      AssetStatus.ACTIVE,
    );
    expect(assetStatusForRepair(MaintenanceStatus.NOT_FIXED)).toBe(
      AssetStatus.INACTIVE,
    );
  });
});

describe('resolvedOnFor (R3)', () => {
  const today = day('2026-10-22');

  it('sets the date on the first move to Fixed or Not Fixed', () => {
    expect(resolvedOnFor(null, MaintenanceStatus.FIXED, today)).toEqual(today);
    expect(resolvedOnFor(null, MaintenanceStatus.NOT_FIXED, today)).toEqual(
      today,
    );
    expect(
      resolvedOnFor(null, MaintenanceStatus.IN_PROGRESS, today),
    ).toBeNull();
  });

  it('never resets it after, a reopened repair included', () => {
    const fixed = day('2026-10-15');

    expect(resolvedOnFor(fixed, MaintenanceStatus.FIXED, today)).toEqual(fixed);
    expect(resolvedOnFor(fixed, MaintenanceStatus.PENDING, today)).toEqual(
      fixed,
    );
  });
});

describe('repair tasks', () => {
  it('titles the follow-up as the demo does', () => {
    expect(followUpTitle('MT-000007', 'Cashier terminal')).toBe(
      'Follow up repair MT-000007: Cashier terminal',
    );
    expect(followUpTitle('MT-000007', '')).toBe(
      'Follow up repair MT-000007: asset',
    );
  });

  it('links a General or Maintenance task with no repair, and refuses the rest', () => {
    expect(
      repairTaskProblem({ type: TaskType.GENERAL, maintenanceId: null }),
    ).toBeNull();
    expect(
      repairTaskProblem({ type: TaskType.MAINTENANCE, maintenanceId: null }),
    ).toBeNull();
    expect(
      repairTaskProblem({ type: TaskType.MAINTENANCE, maintenanceId: 'mt' }),
    ).toBe(TASK_HAS_REPAIR_MESSAGE);
    expect(
      repairTaskProblem({ type: TaskType.PURCHASE, maintenanceId: null }),
    ).toBe(REPAIR_TASK_TYPE_MESSAGE);
  });
});
