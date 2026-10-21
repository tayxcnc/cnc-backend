import { Injectable } from '@nestjs/common';
import type { StaffPrincipal } from '../auth/staff-principal';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { AuditService, staffActor } from './audit.service';
import type { PrintRequest } from './dto/print.request';

/**
 * The demo's `print` command on the server (plan §5.3, A19): printing stays
 * in the browser, from data the API already serves (the bill with its
 * totals, payments and latest docket; the business details on
 * `GET /staff/reference`), and the server only records that it happened.
 *
 * The row is the demo's: action `print`, the ref the screen sent, and
 * after `{document, revision}` plus the period for an attendance print.
 * It changes nothing else, so it takes no version and no Idempotency-Key:
 * a retried print is a second print.
 */
@Injectable()
export class PrintService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
  ) {}

  async record(
    actor: StaffPrincipal,
    request: PrintRequest,
    ipAddress: string,
  ): Promise<void> {
    await this.prisma.$transaction((tx) =>
      this.audit.record(
        {
          actor: staffActor(actor),
          action: 'print',
          ref: request.ref,
          after: {
            document: request.document,
            revision: request.revision ?? null,
            ...(request.document === 'attendance' && request.period
              ? { period: request.period }
              : {}),
          },
          ipAddress,
        },
        tx,
      ),
    );
  }
}
