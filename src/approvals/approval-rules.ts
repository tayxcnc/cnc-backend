import {
  type ApprovalStanding,
  approvalRefusal,
  type MoneyActor,
  type PredictedApproval,
} from '../money-control/money-control.service';

/**
 * The Approvals screen's two views (`staff/components/cnc/operations.tsx`,
 * `Approvals`): PENDING, the records awaiting a decision; HISTORY, the
 * records already decided.
 */
export const APPROVAL_VIEWS = ['PENDING', 'HISTORY'] as const;

export type ApprovalView = (typeof APPROVAL_VIEWS)[number];

/**
 * Who a pending record awaits. OWNER: its value is above the Owner Approval
 * Limit, so no manager may approve it. MANAGER: any manager may, within
 * their Daily Approval Limit, except the one who raised it; the Owner
 * always may.
 */
export const APPROVAL_AWAITERS = ['MANAGER', 'OWNER'] as const;

export type ApprovalAwaiter = (typeof APPROVAL_AWAITERS)[number];

/** What a pending record awaits, and whether the reader may give it. */
export interface ApprovalAwaiting {
  awaits: ApprovalAwaiter;
  /** The value the approval would be judged on now, in kobo. */
  valueKobo: number;
  /** True when the reader's approval would pass now. */
  readerMayApprove: boolean;
  /**
   * The sentence the reader's approval would be refused with now, byte for
   * byte the command's (the limit, the day's limit or the own record, in the
   * demo's order); null when it would pass.
   */
  refusal: string | null;
}

/**
 * What a pending record awaits, as the reader stands now. Each record is
 * judged on its own against the reader's total so far today: approving one
 * adds to the total the next is judged on, which the screen sees on its
 * next read. The command decides again under the ledger's lock, so this is
 * a prediction, never a permission.
 */
export function awaitingApproval(
  reader: MoneyActor,
  standing: ApprovalStanding,
  approval: PredictedApproval,
): ApprovalAwaiting {
  const refusal = approvalRefusal(reader, standing, approval);

  return {
    awaits:
      Math.abs(approval.amountKobo) > standing.approvalLimitKobo
        ? 'OWNER'
        : 'MANAGER',
    valueKobo: approval.amountKobo,
    readerMayApprove: refusal === null,
    refusal,
  };
}
