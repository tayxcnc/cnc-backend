import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  AuditActorKind,
  type Prisma,
  StaffRole,
} from '../../generated/cnc-client';
import type { StaffPrincipal } from '../auth/staff-principal';
import { ROLE_REFUSED_MESSAGE, isManager, isOwner } from '../auth/staff-roles';
import { parseIsoDate } from '../common/calendar-date';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { watDayBounds } from '../common/wat';
import { DELETED_CUSTOMER_NAME } from '../customers/customer-deletion.service';
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
  customerId: true,
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

    const withheld = await this.deletedCustomersRows(rows);

    return {
      data: rows.map((row) => toResponse(row, withheld.has(row.id))),
      page,
      pageSize,
      total,
    };
  }

  /**
   * The rows on this page about a customer who deleted their account (Q36,
   * card C8-5): written by that customer, or about a booking, a bill or a
   * checkout that deletion anonymised. The audit log keeps what it recorded
   * (A13, append-only by trigger), so the person is taken out at the read:
   * the actor shows as "Deleted customer" and the guest's fields are
   * described without their values. A booking or a web order anonymised
   * because it carried the account's email shows the deletion's name, which
   * is how it is found here.
   *
   * A table's `table.release` row is under the table's ref, not the
   * booking's, and carries the seated guest's name: it is withheld when
   * the seating it names (`sessionId`) came from a booking deletion
   * anonymised. A release written before the row carried its seating
   * (C8 review; on local and staging test data only, as production had no
   * guests yet) cannot be joined and is shown as recorded.
   *
   * At most five queries per page, each on a unique or indexed column.
   */
  private async deletedCustomersRows(rows: AuditRow[]): Promise<Set<string>> {
    const refs = [
      ...new Set(rows.flatMap((row) => (row.ref === null ? [] : [row.ref]))),
    ];
    const seatings = [
      ...new Set(
        rows.flatMap((row) => {
          const sessionId = releasedSession(row);

          return sessionId === null ? [] : [sessionId];
        }),
      ),
    ];
    const actors = [
      ...new Set(
        rows.flatMap((row) =>
          row.customerId === null ? [] : [row.customerId],
        ),
      ),
    ];
    const gone = new Set<string>();

    if (actors.length > 0) {
      const deleted = await this.prisma.customer.findMany({
        where: { id: { in: actors }, deletedAt: { not: null } },
        select: { id: true },
      });

      for (const { id } of deleted) gone.add(`customer:${id}`);
    }

    if (refs.length > 0) {
      const anonymised = { not: null };
      const bookings = await this.prisma.reservation.findMany({
        where: {
          number: { in: refs },
          OR: [
            { customer: { deletedAt: anonymised } },
            { name: DELETED_CUSTOMER_NAME },
          ],
        },
        select: { number: true },
      });
      const bills = await this.prisma.order.findMany({
        where: {
          number: { in: refs },
          OR: [
            { customer: { deletedAt: anonymised } },
            { onlineOrder: { contactName: DELETED_CUSTOMER_NAME } },
          ],
        },
        select: { number: true },
      });
      const checkouts = await this.prisma.checkout.findMany({
        where: { reference: { in: refs }, contactName: DELETED_CUSTOMER_NAME },
        select: { reference: true },
      });

      for (const { number } of [...bookings, ...bills]) {
        gone.add(`ref:${number}`);
      }
      for (const { reference } of checkouts) gone.add(`ref:${reference}`);
    }

    if (seatings.length > 0) {
      const anonymised = await this.prisma.tableSession.findMany({
        where: {
          id: { in: seatings },
          reservation: {
            OR: [
              { customer: { deletedAt: { not: null } } },
              { name: DELETED_CUSTOMER_NAME },
            ],
          },
        },
        select: { id: true },
      });

      for (const { id } of anonymised) gone.add(`session:${id}`);
    }

    return new Set(
      rows
        .filter((row) => {
          const sessionId = releasedSession(row);

          return (
            (row.customerId !== null &&
              gone.has(`customer:${row.customerId}`)) ||
            (row.ref !== null && gone.has(`ref:${row.ref}`)) ||
            (sessionId !== null && gone.has(`session:${sessionId}`))
          );
        })
        .map((row) => row.id),
    );
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

/** The seating a `table.release` row ended, or null (`sessionId`). */
function releasedSession(row: AuditRow): string | null {
  if (row.action !== 'table.release') return null;

  const before = row.before;

  if (before === null || typeof before !== 'object' || Array.isArray(before)) {
    return null;
  }

  const sessionId = before.sessionId;

  return typeof sessionId === 'string' ? sessionId : null;
}

/**
 * Field by field, so `before` and `after` can never ride along. `withheld`:
 * the row is about a deleted customer (`deletedCustomersRows`).
 */
function toResponse(row: AuditRow, withheld: boolean): AuditEntryResponse {
  return {
    id: row.id,
    at: row.at,
    actorKind: row.actorKind,
    staffId: row.staffId,
    actorName:
      withheld && row.actorKind === AuditActorKind.CUSTOMER
        ? DELETED_CUSTOMER_NAME
        : row.actorName,
    actorRole: (row.actorRole as StaffRole | null) ?? null,
    action: row.action,
    actionLabel: actionLabel(row.action),
    module: row.module,
    ref: row.ref,
    reason: row.reason,
    changes: describeChange(row.before, row.after, {
      withholdContacts: withheld,
    }),
  };
}
