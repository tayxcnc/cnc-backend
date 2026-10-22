import { Injectable } from '@nestjs/common';
import type { StaffPrincipal } from '../auth/staff-principal';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import {
  LIMITED_DECISIONS,
  MoneyControlService,
  OWN_RECORD_KINDS,
} from '../money-control/money-control.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { PurchasesService } from '../purchasing/purchases.service';
import { WasteService } from '../waste/waste.service';
import { awaitingApproval } from './approval-rules';
import type { ApprovalsQuery } from './dto/approvals.request';
import type {
  ApprovalsResponse,
  WasteApprovalResponse,
} from './dto/approvals.response';

/**
 * The Approvals screen (plan §5.4 "Approvals (M)", §6.1; card C5-8): the
 * manager's desk of requisitions and waste entries awaiting a decision, or
 * already decided. It decides nothing: the decisions are
 * `purchase.approve`/`reject` and `waste.approve`/`reject` on their own
 * routes.
 *
 * In the Pending view each record carries what it awaits: the Owner, when
 * it is above the Owner Approval Limit, or a manager; and whether the
 * reader's own approval would pass now, with the command's exact refusal
 * when it would not (`approvalRefusal`: the same limits, the reader's
 * total so far today and the own-record rule, in the demo's order). A
 * waste entry is valued afresh, as its approval values it
 * (`WasteService.decisionValueKobo`).
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly purchases: PurchasesService,
    private readonly waste: WasteService,
    private readonly money: MoneyControlService,
  ) {}

  /** `GET /staff/approvals`. */
  async read(
    actor: StaffPrincipal,
    query: ApprovalsQuery,
  ): Promise<ApprovalsResponse> {
    const view = query.view ?? 'PENDING';
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const pending = view === 'PENDING';

    const standing = await this.money.standing(this.prisma, actor);
    const purchases = await this.purchases.approvalsPage(
      view,
      query.q,
      page,
      pageSize,
    );
    const waste = await this.waste.approvalsPage(view, query.q, page, pageSize);

    const wasteData: WasteApprovalResponse[] = [];

    for (const entry of waste.data) {
      wasteData.push({
        ...entry,
        awaiting: pending
          ? awaitingApproval(actor, standing, {
              amountKobo: await this.waste.decisionValueKobo(
                this.prisma,
                entry,
              ),
              what: LIMITED_DECISIONS.writeOff,
              createdById: entry.createdById,
              ownKind: OWN_RECORD_KINDS.wasteEntry,
            })
          : null,
      });
    }

    return {
      view,
      page,
      pageSize,
      purchases: {
        data: purchases.data.map((purchase) => ({
          ...purchase,
          awaiting: pending
            ? awaitingApproval(actor, standing, {
                amountKobo: purchase.totalKobo,
                what: LIMITED_DECISIONS.purchase,
                createdById: purchase.createdById,
                ownKind: OWN_RECORD_KINDS.purchase,
              })
            : null,
        })),
        total: purchases.total,
      },
      waste: { data: wasteData, total: waste.total },
      counts: {
        pendingPurchases: await this.purchases.pendingCount(),
        pendingWaste: await this.waste.pendingCount(),
      },
      standing,
    };
  }
}
