import { StaffRole } from '../../generated/cnc-client';
import type { AuditRefReader } from '../audit/audit-ref-access';
import type { CncPrismaService } from '../prisma/cnc-prisma.service';
import { DOCKET_REF_PREFIX } from './docket-items';

/**
 * Who besides a manager may read a bill's or a docket's history
 * (`GET /staff/audit?ref=`, plan §4.8, §6.1). Managers never reach these
 * readers; their rule is the actor filter.
 *
 * - **A bill** (`CNCR-…`, `CNCB-…`): the Point of Sale roles, Cashier,
 *   Waiter and Bartender, a Bartender for Bar bills only, as the till
 *   itself filters.
 * - **A docket** (`KOT-CNCR-…`): the Kitchen, which works from the docket
 *   number, and the Cashier and Waiter, who print it. A docket is a
 *   Restaurant record, so a Bartender never reads one.
 *
 * The record must exist: a ref nobody issued has no history to read, and
 * the answer is the registry's fail-closed refusal.
 */

/** Bill numbers: `CNCR-000001`, `CNCB-000001` (never `CNC-` or `CNC-S`). */
const ORDER_REF = /^CNC[RB]-\d+$/;

const ORDER_READERS: readonly StaffRole[] = [
  StaffRole.CASHIER,
  StaffRole.WAITER,
  StaffRole.BARTENDER,
];

const DOCKET_READERS: readonly StaffRole[] = [
  StaffRole.KITCHEN,
  StaffRole.CASHIER,
  StaffRole.WAITER,
];

/** The reader for bill numbers. */
export function orderRefReader(
  prisma: Pick<CncPrismaService, 'order'>,
): AuditRefReader {
  return {
    owns: (ref) => ORDER_REF.test(ref),
    mayRead: async (viewer, ref) => {
      if (!ORDER_READERS.includes(viewer.role)) return false;
      if (viewer.role === StaffRole.BARTENDER && !ref.startsWith('CNCB-')) {
        return false;
      }

      const order = await prisma.order.findUnique({
        where: { number: ref },
        select: { id: true },
      });

      return order !== null;
    },
  };
}

/** The reader for kitchen docket refs. */
export function docketRefReader(
  prisma: Pick<CncPrismaService, 'docket'>,
): AuditRefReader {
  return {
    owns: (ref) => ref.startsWith(DOCKET_REF_PREFIX),
    mayRead: async (viewer, ref) => {
      if (!DOCKET_READERS.includes(viewer.role)) return false;

      const docket = await prisma.docket.findFirst({
        where: { ref },
        select: { id: true },
      });

      return docket !== null;
    },
  };
}
