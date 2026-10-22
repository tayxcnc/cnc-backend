import { ApiProperty } from '@nestjs/swagger';
import { PurchaseResponse } from '../../purchasing/dto/purchases.response';
import { WasteResponse } from '../../waste/dto/waste.response';
import {
  APPROVAL_AWAITERS,
  type ApprovalAwaiter,
  APPROVAL_VIEWS,
  type ApprovalView,
} from '../approval-rules';

/** What a pending record awaits, and whether the reader may give it. */
export class ApprovalAwaitingResponse {
  @ApiProperty({
    enum: APPROVAL_AWAITERS,
    enumName: 'ApprovalAwaiter',
    description:
      'OWNER: above the Owner Approval Limit, so only the Owner may approve ' +
      'it. MANAGER: any manager within their Daily Approval Limit except ' +
      'the one who raised it, or the Owner.',
  })
  awaits!: ApprovalAwaiter;

  @ApiProperty({
    description:
      'What the approval would be judged on now, in kobo: a requisition’s ' +
      'total, or a waste entry valued afresh by the coded formula (Q25).',
    example: 4000000,
  })
  valueKobo!: number;

  @ApiProperty({
    description: 'True when the reader’s approval would pass now.',
  })
  readerMayApprove!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The sentence the reader’s approval would be refused with now, exactly ' +
      'as the approve route words it; null when it would pass. A ' +
      'prediction: the route decides again when it is called.',
    example:
      'This purchase is above the Owner Approval Limit of ₦50,000. The ' +
      'Owner must approve it.',
  })
  refusal!: string | null;
}

/** A requisition on the Approvals screen. */
export class PurchaseApprovalResponse extends PurchaseResponse {
  @ApiProperty({
    type: ApprovalAwaitingResponse,
    nullable: true,
    description: 'In the Pending view; null in History.',
  })
  awaiting!: ApprovalAwaitingResponse | null;
}

/** A waste entry on the Approvals screen. */
export class WasteApprovalResponse extends WasteResponse {
  @ApiProperty({
    type: ApprovalAwaitingResponse,
    nullable: true,
    description: 'In the Pending view; null in History.',
  })
  awaiting!: ApprovalAwaitingResponse | null;
}

export class PurchaseApprovalListResponse {
  @ApiProperty({ type: PurchaseApprovalResponse, isArray: true })
  data!: PurchaseApprovalResponse[];
  @ApiProperty() total!: number;
}

export class WasteApprovalListResponse {
  @ApiProperty({ type: WasteApprovalResponse, isArray: true })
  data!: WasteApprovalResponse[];
  @ApiProperty() total!: number;
}

/** Where the reader stands against the limits today. */
export class ApprovalStandingResponse {
  @ApiProperty({ example: 5000000 }) approvalLimitKobo!: number;
  @ApiProperty() dailyLimitOn!: boolean;
  @ApiProperty({ example: 15000000 }) dailyLimitKobo!: number;
  @ApiProperty({
    description:
      'What the reader has approved today (Lagos business date), counted ' +
      'toward the Daily Approval Limit. Always 0 for the Owner, who is ' +
      'never counted.',
  })
  approvedTodayKobo!: number;
}

/** Records awaiting a decision, whatever the view and search. */
export class ApprovalCountsResponse {
  @ApiProperty({ description: 'Requisitions Pending and not archived.' })
  pendingPurchases!: number;
  @ApiProperty({ description: 'Waste entries Pending, at every location.' })
  pendingWaste!: number;
}

/** `GET /staff/approvals`. */
export class ApprovalsResponse {
  @ApiProperty({ enum: APPROVAL_VIEWS, enumName: 'ApprovalView' })
  view!: ApprovalView;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ type: PurchaseApprovalListResponse })
  purchases!: PurchaseApprovalListResponse;
  @ApiProperty({ type: WasteApprovalListResponse })
  waste!: WasteApprovalListResponse;
  @ApiProperty({ type: ApprovalCountsResponse })
  counts!: ApprovalCountsResponse;
  @ApiProperty({ type: ApprovalStandingResponse })
  standing!: ApprovalStandingResponse;
}
