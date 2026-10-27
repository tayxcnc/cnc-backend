import type { AuditRefReader } from '../audit/audit-ref-access';
import type { CncPrismaService } from '../prisma/cnc-prisma.service';
import { wasteLocationFor } from './waste-rules';

/** Waste numbers: `W-000001`. */
const WASTE_REF = /^W-\d+$/;

/**
 * Who besides a manager may read a waste entry's history
 * (`GET /staff/audit?ref=W-…`, plan §4.8): the roles that log waste, each
 * for its own location's entries, as their waste read shows them
 * (`wasteLocationFor`: a Kitchen user the Kitchen's, a Bartender or a
 * Cashier the Bar's, the Storekeeper the Store's). The entry must exist: a
 * ref nobody issued gets the registry's refusal. Managers never reach this
 * reader; their rule is the actor filter.
 */
export function wasteRefReader(
  prisma: Pick<CncPrismaService, 'wasteEntry'>,
): AuditRefReader {
  return {
    owns: (ref) => WASTE_REF.test(ref),
    mayRead: async (viewer, ref) => {
      const own = wasteLocationFor(viewer.role);

      if (own === undefined) return false;

      const entry = await prisma.wasteEntry.findUnique({
        where: { number: ref },
        select: { location: true },
      });

      return entry !== null && entry.location === own;
    },
  };
}
