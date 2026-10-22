import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AssetStatus, Prisma } from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import { uniqueViolationTargets } from '../prisma/unique-violation';
import {
  ASSET_NOT_FOUND_MESSAGE,
  ASSET_TAG_TAKEN_MESSAGE,
} from './asset-messages';
import type { AssetsQuery, SaveAssetRequest } from './dto/assets.request';
import type { AssetPageResponse, AssetResponse } from './dto/assets.response';
import { assetFieldsProblem } from './maintenance-rules';

/** The columns an asset is answered from. */
export const ASSET_COLUMNS = {
  id: true,
  tag: true,
  name: true,
  category: true,
  location: true,
  quantity: true,
  status: true,
  version: true,
} satisfies Prisma.AssetSelect;

type AssetRow = Prisma.AssetGetPayload<{ select: typeof ASSET_COLUMNS }>;

/** What an audit row says about an asset: its fields, never its id. */
function auditFields(row: AssetRow) {
  return {
    name: row.name,
    category: row.category || null,
    location: row.location || null,
    quantity: row.quantity,
    status: row.status,
  };
}

/** What `asset.save` answers, and whether it added the asset. */
export interface SavedAsset {
  created: boolean;
  asset: AssetResponse;
}

/**
 * Assets (plan §4.7, §5.4; card C5-6): the venue's equipment and furniture,
 * by tag. Managers add and change them (`asset.save`); Reception reads them
 * to log a repair, and repairs move an asset's status (`MaintenanceService`).
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
  ) {}

  /** `GET /staff/assets`: by tag, with status and search filters. */
  async list(query: AssetsQuery): Promise<AssetPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const filters: Prisma.AssetWhereInput[] = [];

    if (query.status) filters.push({ status: query.status });

    if (query.q) {
      const contains = {
        contains: query.q,
        mode: Prisma.QueryMode.insensitive,
      };

      filters.push({
        OR: [
          { tag: contains },
          { name: contains },
          { category: contains },
          { location: contains },
        ],
      });
    }

    const where: Prisma.AssetWhereInput = { AND: filters };
    const rows = await this.prisma.asset.findMany({
      where,
      orderBy: [{ tag: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: ASSET_COLUMNS,
    });
    const total = await this.prisma.asset.count({ where });

    return { data: rows, page, pageSize, total };
  }

  /**
   * `asset.save` (`PUT /staff/assets/:tag`), managers: the demo's check on
   * the tag, name and quantity first, then
   *
   * - **with no `version`**, a new asset under the tag, Active unless a
   *   status is sent. A tag already held is 409: a create names no version,
   *   so it must not overwrite an asset nobody read, and a retry after a
   *   lost response is refused on the tag (the *Idempotency* rule for
   *   creates), as a new stock item is on its name;
   * - **with a `version`**, the asset the tag names, claimed at that
   *   version. Its status changes only when one is sent (R2's rule): the
   *   demo set an asset Active whenever the form left the status out, which
   *   would quietly undo a repair's Under Repair.
   */
  async save(
    actor: StaffPrincipal,
    tagParam: string,
    request: SaveAssetRequest,
    ipAddress: string,
  ): Promise<SavedAsset> {
    const tag = tagParam.trim();
    const problem = assetFieldsProblem(tag, request.name, request.quantity);

    if (problem !== null) throw new BadRequestException(problem);

    // `assetFieldsProblem` has proved a name and a whole quantity.
    const name = (request.name as string).trim();
    const quantity = request.quantity as number;
    const fields = {
      name,
      quantity,
      category: request.category ?? '',
      location: request.location ?? '',
    };

    if (request.version === undefined) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const created = await tx.asset.create({
            data: {
              tag,
              ...fields,
              status: request.status ?? AssetStatus.ACTIVE,
            },
            select: ASSET_COLUMNS,
          });

          await this.audit.record(
            {
              actor: staffActor(actor),
              action: 'asset.save',
              ref: created.tag,
              after: auditFields(created),
              ipAddress,
            },
            tx,
          );

          return { created: true, asset: created };
        });
      } catch (error) {
        if (uniqueViolationTargets(error).includes('tag')) {
          throw new ConflictException(ASSET_TAG_TAKEN_MESSAGE);
        }

        throw error;
      }
    }

    const version = request.version;

    return this.prisma.$transaction(async (tx) => {
      const found = await tx.asset.findUnique({
        where: { tag },
        select: { id: true },
      });

      if (found === null) throw new NotFoundException(ASSET_NOT_FOUND_MESSAGE);

      await claimVersion(tx, {
        table: 'Asset',
        id: found.id,
        version,
        notFound: ASSET_NOT_FOUND_MESSAGE,
      });

      const current = await tx.asset.findUniqueOrThrow({
        where: { id: found.id },
        select: ASSET_COLUMNS,
      });
      const updated = await tx.asset.update({
        where: { id: found.id },
        data: {
          ...fields,
          ...(request.status !== undefined ? { status: request.status } : {}),
        },
        select: ASSET_COLUMNS,
      });

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'asset.save',
          ref: updated.tag,
          before: auditFields(current),
          after: auditFields(updated),
          ipAddress,
        },
        tx,
      );

      return { created: false, asset: updated };
    });
  }
}
