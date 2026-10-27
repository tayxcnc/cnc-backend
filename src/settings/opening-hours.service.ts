import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import {
  MoneyControlService,
  OWNER_ONLY_TIMES_MESSAGE,
} from '../money-control/money-control.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import type {
  OpeningHoursResponse,
  ReplaceOpeningHoursRequest,
} from './dto/opening-hours.dto';
import { toOpeningHours, toStoredWeek, weekForAudit } from './opening-hours';

const DAY_SELECT = {
  dayOfWeek: true,
  isClosed: true,
  opensAtMinutes: true,
  closesAtMinutes: true,
  updatedAt: true,
} satisfies Prisma.OpeningHoursDaySelect;

/** The audit action for a saved week: filed under Settings by its prefix. */
export const OPENING_HOURS_ACTION = 'settings.openingHours';

/**
 * CNC's weekly opening hours (plan §4.1, D26): TAY's
 * `OpeningHoursService`, copied, with CNC's rule on who may write them.
 *
 * Owner only until Q29 is answered (its default: "the Owner only, like VAT
 * and fees, because the owner confirmed them"). The public read is
 * `GET /opening-hours` (C6-4); the staff app reads the week from
 * `GET /staff/settings`.
 */
@Injectable()
export class OpeningHoursService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
    private readonly money: MoneyControlService,
  ) {}

  /** The week, on the service's client or a caller's transaction. */
  async read(
    reader: Pick<Prisma.TransactionClient, 'openingHoursDay'> = this.prisma,
  ): Promise<OpeningHoursResponse> {
    return toOpeningHours(
      await reader.openingHoursDay.findMany({
        select: DAY_SELECT,
        orderBy: { dayOfWeek: 'asc' },
      }),
    );
  }

  /**
   * Replace the week: all seven rows, one transaction, one audit row.
   *
   * The table has no `version` (A8 lists no hours), so two saves are taken
   * one after the other by an advisory lock, as in TAY: the last save is
   * the whole week, never one Owner's Monday beside another's Tuesday.
   * Delete and insert, because the request is the whole week and nothing
   * is carried over. The audit row keeps the week it replaced, one plain
   * field per day.
   */
  async replace(
    actor: StaffPrincipal,
    request: ReplaceOpeningHoursRequest,
    ipAddress: string,
  ): Promise<OpeningHoursResponse> {
    this.money.requireOwner(actor, OWNER_ONLY_TIMES_MESSAGE);

    const week = toStoredWeek(request.days);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cnc:opening-hours'))`;

      const previous = await this.read(tx);

      await tx.openingHoursDay.deleteMany({});
      await tx.openingHoursDay.createMany({ data: week });

      const current = await this.read(tx);

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: OPENING_HOURS_ACTION,
          ref: null,
          before: weekForAudit(previous.days),
          after: weekForAudit(current.days),
          ipAddress,
        },
        tx,
      );

      return current;
    });
  }
}
