import { StaffRole } from '../../generated/cnc-client';
import type { AuditRefReader } from '../audit/audit-ref-access';
import type { CncPrismaService } from '../prisma/cnc-prisma.service';

/** Purchase numbers: `PR-000001`. */
const PURCHASE_REF = /^PR-\d+$/;

/**
 * Who besides a manager may read a purchase's history
 * (`GET /staff/audit?ref=PR-…`, plan §4.8): the Storekeeper, the one other
 * role that opens Purchasing (§6.1), for every purchase, as their list
 * shows them all. The purchase must exist: a ref nobody issued gets the
 * registry's refusal. Managers never reach this reader; their rule is the
 * actor filter.
 */
export function purchaseRefReader(
  prisma: Pick<CncPrismaService, 'purchase'>,
): AuditRefReader {
  return {
    owns: (ref) => PURCHASE_REF.test(ref),
    mayRead: async (viewer, ref) => {
      if (viewer.role !== StaffRole.STOREKEEPER) return false;

      const purchase = await prisma.purchase.findUnique({
        where: { number: ref },
        select: { id: true },
      });

      return purchase !== null;
    },
  };
}
