import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type MaintenanceStatus,
  Prisma,
  TaskStatus,
  TaskType,
} from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import { formatIsoDate } from '../common/calendar-date';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { watToday } from '../common/wat';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import { drawNumber } from '../prisma/sequences';
import {
  closeOpenTasks,
  managerForTask,
  raiseAutomaticTask,
} from '../tasks/automatic-tasks';
import { TASK_NOT_FOUND_MESSAGE } from '../tasks/task-messages';
import {
  REPAIR_ASSET_VENDOR_MESSAGE,
  REPAIR_NOT_FOUND_MESSAGE,
  REPAIR_STATUS_MESSAGE,
  REPAIR_TASK_TYPE_MESSAGE,
  TASK_HAS_REPAIR_MESSAGE,
} from './asset-messages';
import type {
  CreateRepairRequest,
  RepairsQuery,
  UpdateRepairRequest,
} from './dto/assets.request';
import type { RepairPageResponse, RepairResponse } from './dto/assets.response';
import {
  assetStatusForRepair,
  followUpTitle,
  isRepairStatus,
  isResolved,
  repairFieldsProblem,
  repairTaskProblem,
  resolvedOnFor,
} from './maintenance-rules';

type Tx = Prisma.TransactionClient;

/** What the answers are read through: the pool, or a command's transaction. */
type Reader = Pick<
  Prisma.TransactionClient,
  'asset' | 'vendor' | 'maintenanceHistory' | 'task' | 'staff'
>;

/** The columns a repair is answered from, without its relations. */
const REPAIR_COLUMNS = {
  id: true,
  number: true,
  assetId: true,
  vendorId: true,
  description: true,
  costKobo: true,
  reportedOn: true,
  resolvedOn: true,
  status: true,
  createdAt: true,
  version: true,
} satisfies Prisma.MaintenanceRecordSelect;

type RepairRow = Prisma.MaintenanceRecordGetPayload<{
  select: typeof REPAIR_COLUMNS;
}>;

/** An id field as sent: a non-blank string, or nothing. */
function sentId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** What an audit row says about a repair: names and dates, never ids. */
function auditFields(row: RepairRow, assetTag: string, vendorName: string) {
  return {
    asset: assetTag,
    vendor: vendorName,
    description: row.description,
    costKobo: row.costKobo,
    status: row.status,
    reportedOn: formatIsoDate(row.reportedOn),
    resolvedOn: row.resolvedOn === null ? null : formatIsoDate(row.resolvedOn),
  };
}

/**
 * Repairs (plan §4.7, §5.4, §7.9, §17 R3; card C5-6): `maintenance.save`,
 * by which Reception logs a repair on an asset and moves it through
 * Pending, In Progress, Fixed and Not Fixed, and the repairs read. Reactive
 * only (Q13's default): nothing is scheduled.
 *
 * - **The asset follows its repair**: Under Repair while it is Pending or
 *   In Progress, Active once Fixed, Inactive when it could not be fixed.
 * - **The follow-up task** (plan §7.9, "repairs open and close their own
 *   follow-up task"): a new repair raises "Follow up repair MT-…: <asset>"
 *   for a manager, unless it was logged for an existing task, which is then
 *   linked and moved to In Progress; Fixed or Not Fixed closes every open
 *   task on the repair. Both go through `automatic-tasks.ts`, inside the
 *   command's transaction.
 * - **R3**: the resolved date is set once, on the first move to Fixed or
 *   Not Fixed, and an unknown task is a 404 rather than the demo's crash.
 *
 * Every save adds a `MaintenanceHistory` row and an audit row
 * `maintenance.save` under the repair number, in the same transaction; an
 * update claims the repair's `version` first (A8).
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
  ) {}

  /** `GET /staff/maintenance`: newest first, with status and search filters. */
  async list(query: RepairsQuery): Promise<RepairPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const filters: Prisma.MaintenanceRecordWhereInput[] = [];

    if (query.status) filters.push({ status: query.status });

    if (query.q) {
      const contains = {
        contains: query.q,
        mode: Prisma.QueryMode.insensitive,
      };

      filters.push({
        OR: [
          { number: contains },
          { description: contains },
          { asset: { tag: contains } },
          { asset: { name: contains } },
        ],
      });
    }

    const where: Prisma.MaintenanceRecordWhereInput = { AND: filters };
    const rows = await this.prisma.maintenanceRecord.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: REPAIR_COLUMNS,
    });
    const total = await this.prisma.maintenanceRecord.count({ where });

    return {
      data: await this.answerMany(this.prisma, rows),
      page,
      pageSize,
      total,
    };
  }

  /**
   * `maintenance.save` logging a repair. Runs inside the idempotency
   * service's transaction: a retry after a lost response replays the
   * first repair instead of logging a second, with a second follow-up.
   */
  create(
    tx: Tx,
    actor: StaffPrincipal,
    request: CreateRepairRequest,
    ipAddress: string,
  ): Promise<RepairResponse> {
    return this.save(tx, actor, null, request, ipAddress);
  }

  /** `maintenance.save` on a repair that exists: claims its version first. */
  update(
    actor: StaffPrincipal,
    id: string,
    request: UpdateRepairRequest,
    ipAddress: string,
  ): Promise<RepairResponse> {
    return this.prisma.$transaction(async (tx) => {
      await claimVersion(tx, {
        table: 'MaintenanceRecord',
        id,
        version: request.version,
        notFound: REPAIR_NOT_FOUND_MESSAGE,
      });

      const current = await tx.maintenanceRecord.findUniqueOrThrow({
        where: { id },
        select: REPAIR_COLUMNS,
      });

      return this.save(tx, actor, current, request, ipAddress);
    });
  }

  /**
   * The demo's `maintenance.save`, in its order: the asset and vendor, the
   * description and cost, the status, then the task it is logged for (404
   * for an unknown one, R3).
   */
  private async save(
    tx: Tx,
    actor: StaffPrincipal,
    current: RepairRow | null,
    request: CreateRepairRequest | UpdateRepairRequest,
    ipAddress: string,
  ): Promise<RepairResponse> {
    const assetId = sentId(request.assetId);
    const vendorId = sentId(request.vendorId);
    const asset =
      assetId === undefined
        ? null
        : await tx.asset.findUnique({
            where: { id: assetId },
            select: { id: true, tag: true, name: true },
          });
    const vendor =
      vendorId === undefined
        ? null
        : await tx.vendor.findUnique({
            where: { id: vendorId },
            select: { id: true, name: true },
          });

    if (asset === null || vendor === null) {
      throw new BadRequestException(REPAIR_ASSET_VENDOR_MESSAGE);
    }

    const fieldsProblem = repairFieldsProblem(
      request.description,
      request.costKobo,
    );

    if (fieldsProblem !== null) throw new BadRequestException(fieldsProblem);
    if (!isRepairStatus(request.status)) {
      throw new BadRequestException(REPAIR_STATUS_MESSAGE);
    }

    // `repairFieldsProblem` has proved a description and a whole cost.
    const description = (request.description as string).trim();
    const costKobo = request.costKobo as number;
    const status: MaintenanceStatus = request.status;
    const taskId = await this.taskToLink(tx, request.taskId, current);
    const today = watToday(new Date());
    const data = {
      assetId: asset.id,
      vendorId: vendor.id,
      description,
      costKobo,
      status,
      resolvedOn: resolvedOnFor(current?.resolvedOn ?? null, status, today),
    };
    const saved =
      current === null
        ? await tx.maintenanceRecord.create({
            data: {
              ...data,
              number: await drawNumber(tx, 'maintenance'),
              reportedOn: today,
            },
            select: REPAIR_COLUMNS,
          })
        : await tx.maintenanceRecord.update({
            where: { id: current.id },
            data,
            select: REPAIR_COLUMNS,
          });

    await tx.maintenanceHistory.create({
      data: { recordId: saved.id, status, staffId: actor.id },
    });

    // The demo sets the asset's status on every save. One conditional
    // update writes it only when it changes, so an unchanged asset's
    // version does not move under a manager's open form for nothing, and
    // the comparison is made on the row as it stands, not as it was read.
    const assetStatus = assetStatusForRepair(status);

    await tx.asset.updateMany({
      where: { id: asset.id, status: { not: assetStatus } },
      data: { status: assetStatus, version: { increment: 1 } },
    });

    if (taskId !== undefined) {
      await this.linkTask(tx, actor, taskId, saved.id);
    } else if (current === null) {
      await raiseAutomaticTask(tx, {
        title: followUpTitle(saved.number, asset.name),
        type: TaskType.MAINTENANCE,
        assignedToId: await managerForTask(tx, actor.id),
        raisedById: actor.id,
        maintenanceId: saved.id,
      });
    }

    if (isResolved(status)) {
      await closeOpenTasks(
        tx,
        { maintenanceId: saved.id, automaticOnly: false },
        actor.id,
      );
    }

    let before: ReturnType<typeof auditFields> | undefined;

    if (current !== null) {
      const oldAsset = await tx.asset.findUniqueOrThrow({
        where: { id: current.assetId },
        select: { tag: true },
      });
      const oldVendor = await tx.vendor.findUniqueOrThrow({
        where: { id: current.vendorId },
        select: { name: true },
      });

      before = auditFields(current, oldAsset.tag, oldVendor.name);
    }

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'maintenance.save',
        ref: saved.number,
        before,
        after: auditFields(saved, asset.tag, vendor.name),
        reason: request.reason ?? null,
        ipAddress,
      },
      tx,
    );

    const [answer] = await this.answerMany(tx, [saved]);

    return answer;
  }

  /**
   * The task a repair is logged for, when one is sent: it must exist (404
   * "Task not found.", R3: the demo crashed on an unknown id), must not
   * already track a repair, and must not be a Purchase task. The repair's
   * own task sent again with an update links nothing new and passes, so a
   * screen that sends the whole record back is not refused for it.
   * Undefined when there is nothing to link.
   */
  private async taskToLink(
    tx: Tx,
    value: unknown,
    current: RepairRow | null,
  ): Promise<string | undefined> {
    const taskId = sentId(value);

    if (taskId === undefined) return undefined;

    const task = await tx.task.findUnique({
      where: { id: taskId },
      select: { id: true, type: true, maintenanceId: true },
    });

    if (task === null) throw new NotFoundException(TASK_NOT_FOUND_MESSAGE);
    if (current !== null && task.maintenanceId === current.id) {
      return undefined;
    }

    const problem = repairTaskProblem(task);

    if (problem === TASK_HAS_REPAIR_MESSAGE) {
      throw new ConflictException(problem);
    }

    if (problem === REPAIR_TASK_TYPE_MESSAGE) {
      throw new BadRequestException(problem);
    }

    return task.id;
  }

  /**
   * The demo's link: the task now tracks the repair, as a Maintenance task
   * (`Task_values_check`), and moves to In Progress. One conditional update
   * that requires the task to have no repair yet, so two repairs logged
   * for one task at once cannot both take it, and that moves its `version`,
   * so a screen holding the task before is refused as stale. An automatic
   * history row records the move, by the person whose command made it.
   */
  private async linkTask(
    tx: Tx,
    actor: StaffPrincipal,
    taskId: string,
    repairId: string,
  ): Promise<void> {
    const linked = await tx.task.updateMany({
      where: {
        id: taskId,
        maintenanceId: null,
        type: { not: TaskType.PURCHASE },
      },
      data: {
        maintenanceId: repairId,
        type: TaskType.MAINTENANCE,
        status: TaskStatus.IN_PROGRESS,
        version: { increment: 1 },
      },
    });

    if (linked.count !== 1) {
      throw new ConflictException(TASK_HAS_REPAIR_MESSAGE);
    }

    await tx.taskHistory.create({
      data: {
        taskId,
        status: TaskStatus.IN_PROGRESS,
        staffId: actor.id,
        automatic: true,
      },
    });
  }

  /**
   * Repairs as the routes answer them. Their assets, vendors, history,
   * tasks and people are separate queries awaited in turn, never a nested
   * select, so this is safe inside a transaction (*Data and migrations*).
   */
  private async answerMany(
    client: Reader,
    rows: readonly RepairRow[],
  ): Promise<RepairResponse[]> {
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    const assets = await client.asset.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.assetId))] } },
      select: { id: true, tag: true, name: true },
    });
    const vendors = await client.vendor.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.vendorId))] } },
      select: { id: true, name: true },
    });
    const history = await client.maintenanceHistory.findMany({
      where: { recordId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { recordId: true, status: true, staffId: true, createdAt: true },
    });
    const tasks = await client.task.findMany({
      where: { maintenanceId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, number: true, status: true, maintenanceId: true },
    });
    const people = await client.staff.findMany({
      where: { id: { in: [...new Set(history.map((step) => step.staffId))] } },
      select: { id: true, name: true },
    });
    const assetOf = new Map(assets.map((asset) => [asset.id, asset]));
    const vendorName = new Map(
      vendors.map((vendor) => [vendor.id, vendor.name]),
    );
    const nameOf = new Map(people.map((person) => [person.id, person.name]));

    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      assetId: row.assetId,
      assetTag: assetOf.get(row.assetId)?.tag ?? '',
      assetName: assetOf.get(row.assetId)?.name ?? '',
      vendorId: row.vendorId,
      vendorName: vendorName.get(row.vendorId) ?? '',
      description: row.description,
      costKobo: row.costKobo,
      reportedOn: formatIsoDate(row.reportedOn),
      resolvedOn:
        row.resolvedOn === null ? null : formatIsoDate(row.resolvedOn),
      status: row.status,
      history: history
        .filter((step) => step.recordId === row.id)
        .map((step) => ({
          status: step.status,
          at: step.createdAt.toISOString(),
          staffId: step.staffId,
          staffName: nameOf.get(step.staffId) ?? '',
        })),
      tasks: tasks
        .filter((task) => task.maintenanceId === row.id)
        .map((task) => ({
          id: task.id,
          number: task.number,
          status: task.status,
        })),
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    }));
  }
}
