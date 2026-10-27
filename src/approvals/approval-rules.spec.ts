import { StaffRole } from '../../generated/cnc-client';
import {
  LIMITED_DECISIONS,
  OWN_RECORD_KINDS,
  ownRecordMessage,
} from '../money-control/money-control.service';
import { awaitingApproval } from './approval-rules';

/**
 * What a pending record awaits (card C5-8). The refusal sentences are the
 * commands' own; `money-control.service.spec.ts` checks that the
 * prediction agrees with `withinLimit` and `notOwn` decision by decision.
 */
describe('awaitingApproval', () => {
  const owner = { id: 'owner-1', role: StaffRole.OWNER };
  const manager = { id: 'manager-1', role: StaffRole.MANAGER };
  const standing = {
    approvalLimitKobo: 5_000_000,
    dailyLimitOn: true,
    dailyLimitKobo: 15_000_000,
    approvedTodayKobo: 0,
  };
  const purchase = (amountKobo: number, createdById = 'storekeeper-1') => ({
    amountKobo,
    what: LIMITED_DECISIONS.purchase,
    createdById,
    ownKind: OWN_RECORD_KINDS.purchase,
  });

  it('awaits the Owner above the Owner Approval Limit, whoever reads it', () => {
    expect(awaitingApproval(manager, standing, purchase(14_000_000))).toEqual({
      awaits: 'OWNER',
      valueKobo: 14_000_000,
      readerMayApprove: false,
      refusal:
        'This purchase is above the Owner Approval Limit of ₦50,000. The Owner must approve it.',
    });
    expect(awaitingApproval(owner, standing, purchase(14_000_000))).toEqual({
      awaits: 'OWNER',
      valueKobo: 14_000_000,
      readerMayApprove: true,
      refusal: null,
    });
  });

  it('awaits a manager at or below the limit, but not the one who raised it', () => {
    expect(awaitingApproval(manager, standing, purchase(5_000_000))).toEqual({
      awaits: 'MANAGER',
      valueKobo: 5_000_000,
      readerMayApprove: true,
      refusal: null,
    });
    expect(
      awaitingApproval(manager, standing, purchase(100_000, manager.id)),
    ).toEqual({
      awaits: 'MANAGER',
      valueKobo: 100_000,
      readerMayApprove: false,
      refusal: ownRecordMessage(OWN_RECORD_KINDS.purchase),
    });
  });

  it('tells a manager whose day is spent that the Owner must approve it, while it still awaits a manager', () => {
    const spent = { ...standing, approvedTodayKobo: 12_000_000 };

    expect(awaitingApproval(manager, spent, purchase(4_000_000))).toEqual({
      awaits: 'MANAGER',
      valueKobo: 4_000_000,
      readerMayApprove: false,
      refusal:
        'This would take your approvals today to ₦160,000, above the Daily Approval Limit of ₦150,000. The Owner must approve it.',
    });
  });
});
