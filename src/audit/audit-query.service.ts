import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { type Prisma, StaffRole } from '../../generated/cnc-client';
import type { StaffPrincipal } from '../auth/staff-principal';
import { ROLE_REFUSED_MESSAGE, isManager, isOwner } from '../auth/staff-roles';
import { parseIsoDate } from '../common/calendar-date';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { watDayBounds } from '../common/wat';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { AuditRefAccess } from './audit-ref-access';
import { actionLabel, describeChange } from './audit-sentences';
import type {
  AuditEntryResponse,
  AuditPageResponse,
} from './dto/audit-entry.response';
import type { AuditListQuery } from './dto/audit-list.query';

/** The one history query Reception may make without a ref (plan §4.8). */
export const RECEPTION_AUDIT_ACTION = 'maintenance.save';

const AUDIT_SELECT = {
  id: true,
  at: true,
  actorKind: true,
  staffId: true,
  actorName: true,
  actorRole: true,
  action: true,
  module: true,
  ref: true,
  reason: true,
  before: true,
  after: true,
} satisfies Prisma.AuditLogSelect;

type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof AUDIT_SELECT }>;

/**
 * Reads the activity history (`GET /staff/audit`) under plan §4.8's rules,
 * and turns each row into plain sentences. Writes nothing: `AuditService`
 * is the one writer.
 *
 * **Who sees what:**
 * - **The Owner** reads every entry.
 * - **A Manager** reads every entry except another Manager's (the demo's
 *   `visibleAudit`), judged by the role snapshotted on the row: an entry
 *   made as a Manager stays a Manager's entry after a promotion. Their own,
 *   the Owner's, staff, customer and system entries are all visible.
 * - **Every other role** may ask for one record's history, `?ref=`, and
 *   only for a record they can read under §6.1 (`AuditRefAccess`, which
 *   fails closed); Reception may also ask for `action=maintenance.save`.
 *   Any other query is 403 with the demo's role sentence. Within a record
 *   they may read, they see all of its entries, as the staff app's record
 *   history showed them.
 */
@Injectable()
export class AuditQueryService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly refAccess: AuditRefAccess,
  ) {}

  async list(
    viewer: StaffPrincipal,
    query: AuditListQuery,
  ): Promise<AuditPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const visibility = await this.visibility(viewer, query);
    const where: Prisma.AuditLogWhereInput = {
      AND: [visibility, this.filters(query)],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        // `id` breaks a tie between rows written in the same millisecond,
        // so a row cannot appear on two pages or on none.
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: AUDIT_SELECT,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data: rows.map(toResponse), page, pageSize, total };
  }

  /**
   * The rows this viewer may see, or a 403 for a query their role may not
   * make. Checked before any row is read.
   */
  private async visibility(
    viewer: StaffPrincipal,
    query: AuditListQuery,
  ): Promise<Prisma.AuditLogWhereInput> {
    if (isOwner(viewer.role)) return {};

    if (isManager(viewer.role)) {
      // Not "NOT (role = MANAGER AND staffId <> me)": SQL's NOT over a null
      // `actorRole` (customer and system rows) is null, and would hide
      // those rows from every manager.
      return {
        OR: [
          { actorRole: null },
          { actorRole: { not: StaffRole.MANAGER } },
          { staffId: viewer.id },
        ],
      };
    }

    const otherFilters =
      query.module !== undefined ||
      query.staffId !== undefined ||
      query.from !== undefined ||
      query.to !== undefined;

    if (otherFilters) throw new ForbiddenException(ROLE_REFUSED_MESSAGE);

    if (query.action !== undefined) {
      if (
        viewer.role === StaffRole.RECEPTION &&
        query.action === RECEPTION_AUDIT_ACTION
      ) {
        return {};
      }

      throw new ForbiddenException(ROLE_REFUSED_MESSAGE);
    }

    if (
      query.ref === undefined ||
      !(await this.refAccess.mayRead(viewer, query.ref))
    ) {
      throw new ForbiddenException(ROLE_REFUSED_MESSAGE);
    }

    return {};
  }

  /** The caller's own filters, each exact; dates are WAT days, inclusive. */
  private filters(query: AuditListQuery): Prisma.AuditLogWhereInput {
    const from =
      query.from === undefined ? undefined : parseIsoDate(query.from);
    const to = query.to === undefined ? undefined : parseIsoDate(query.to);

    if (from === null || to === null) {
      throw new BadRequestException('from and to must be real calendar dates.');
    }

    if (from !== undefined && to !== undefined && from > to) {
      throw new BadRequestException('to must not be before from.');
    }

    return {
      ...(query.module === undefined ? {} : { module: query.module }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.staffId === undefined ? {} : { staffId: query.staffId }),
      ...(query.ref === undefined ? {} : { ref: query.ref }),
      ...(from === undefined && to === undefined
        ? {}
        : {
            at: {
              ...(from === undefined ? {} : { gte: watDayBounds(from).start }),
              ...(to === undefined ? {} : { lt: watDayBounds(to).end }),
            },
          }),
    };
  }
}

/** Field by field, so `before` and `after` can never ride along. */
function toResponse(row: AuditRow): AuditEntryResponse {
  return {
    id: row.id,
    at: row.at,
    actorKind: row.actorKind,
    staffId: row.staffId,
    actorName: row.actorName,
    actorRole: (row.actorRole as StaffRole | null) ?? null,
    action: row.action,
    actionLabel: actionLabel(row.action),
    module: row.module,
    ref: row.ref,
    reason: row.reason,
    changes: describeChange(row.before, row.after),
  };
}
