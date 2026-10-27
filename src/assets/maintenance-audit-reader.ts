import type { AuditRefReader } from '../audit/audit-ref-access';
import type { CncPrismaService } from '../prisma/cnc-prisma.service';
import { pagesFor } from '../shell/staff-pages';

/** Repair numbers: `MT-000001`. */
const REPAIR_REF = /^MT-\d+$/;

/**
 * Who besides a manager may read a repair's history
 * (`GET /staff/audit?ref=MT-…`, plan §4.8, §6.1): a role that opens Assets
 * & Maintenance (Reception, "repairs, history"), for any repair that
 * exists, as its repairs read shows every repair. A ref nobody issued gets
 * the registry's refusal. Managers never reach this reader; their rule is
 * the actor filter. Asset histories (`asset.save`, ref the tag) get no
 * reader: §6.1 gives Reception the assets to read, not their history.
 */
export function maintenanceRefReader(
  prisma: Pick<CncPrismaService, 'maintenanceRecord'>,
): AuditRefReader {
  return {
    owns: (ref) => REPAIR_REF.test(ref),
    mayRead: async (viewer, ref) => {
      if (!pagesFor(viewer.role).includes('maintenance')) return false;

      const repair = await prisma.maintenanceRecord.findUnique({
        where: { number: ref },
        select: { id: true },
      });

      return repair !== null;
    },
  };
}
