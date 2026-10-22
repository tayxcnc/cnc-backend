import { StaffRole } from '../../generated/cnc-client';
import type { AuditRefReader } from '../audit/audit-ref-access';
import type { CncPrismaService } from '../prisma/cnc-prisma.service';
import { scopedStockLocation } from './stock-locations';

/** Stock request numbers: `SR-000001`. */
const REQUEST_REF = /^SR-\d+$/;

/**
 * The roles besides a manager that open Stock & Requests (plan §6.1): the
 * Storekeeper for every location, a Kitchen user for the Kitchen and a
 * Bartender for the Bar. A Cashier may raise a Bar request from the till
 * but has no Stock & Requests page, so §4.8 gives them no request history.
 */
const REQUEST_READERS: readonly StaffRole[] = [
  StaffRole.STOREKEEPER,
  StaffRole.KITCHEN,
  StaffRole.BARTENDER,
];

/**
 * Who besides a manager may read a stock request's history
 * (`GET /staff/audit?ref=SR-…`, plan §4.8): the roles above, each for the
 * requests their own read shows them (`scopedStockLocation`). The request
 * must exist: a ref nobody issued gets the registry's refusal. Managers
 * never reach this reader; their rule is the actor filter.
 */
export function stockRequestRefReader(
  prisma: Pick<CncPrismaService, 'stockRequest'>,
): AuditRefReader {
  return {
    owns: (ref) => REQUEST_REF.test(ref),
    mayRead: async (viewer, ref) => {
      if (!REQUEST_READERS.includes(viewer.role)) return false;

      const request = await prisma.stockRequest.findUnique({
        where: { number: ref },
        select: { location: true },
      });

      if (request === null) return false;

      const scoped = scopedStockLocation(viewer.role);

      return scoped === undefined || scoped === request.location;
    },
  };
}
