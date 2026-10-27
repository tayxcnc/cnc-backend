import { BadRequestException, Injectable } from '@nestjs/common';
import { Department, type Prisma, StockKind } from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  type PaginationQuery,
} from '../common/dto/pagination.query';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import type {
  KitchenMappingLineResponse,
  KitchenMappingPageResponse,
  KitchenMappingResponse,
  SaveKitchenMappingRequest,
} from './dto/kitchen-mapping.dto';
import {
  MAPPING_FOOD_MESSAGE,
  MAPPING_PORTION_MESSAGE,
} from './stock-messages';

type Reader = Pick<Prisma.TransactionClient, 'kitchenMapping' | 'stockItem'>;

/**
 * The comparison rules of some dishes, by menu item id (a rule's portions
 * by creation, then id). Two plain queries awaited in turn (see `readMenuItems`), so
 * it runs inside a transaction too: the staff shell's reference read and
 * the crosscheck (C4-6) read the rules through it.
 */
export async function readKitchenMappings(
  client: Reader,
  menuItemIds?: readonly string[],
): Promise<Map<string, KitchenMappingLineResponse[]>> {
  const rows = await client.kitchenMapping.findMany({
    where: menuItemIds ? { menuItemId: { in: [...menuItemIds] } } : {},
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { menuItemId: true, stockItemId: true, qty: true },
  });

  if (rows.length === 0) return new Map();

  const items = await client.stockItem.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.stockItemId))] } },
    select: { id: true, name: true },
  });
  const names = new Map(items.map((item) => [item.id, item.name]));
  const byMenuItem = new Map<string, KitchenMappingLineResponse[]>();

  for (const row of rows) {
    const lines = byMenuItem.get(row.menuItemId) ?? [];

    lines.push({
      stockItemId: row.stockItemId,
      stockItemName: names.get(row.stockItemId) ?? '',
      qty: row.qty,
    });
    byMenuItem.set(row.menuItemId, lines);
  }

  return byMenuItem;
}

/** What an audit row records of a rule: each portion by name. */
function auditLines(lines: KitchenMappingLineResponse[]) {
  return {
    lines: lines.map((line) => ({ item: line.stockItemName, qty: line.qty })),
  };
}

/**
 * Settings → Kitchen Comparison Rules (plan §5.4; card C4-2): the demo's
 * `mapping.save`, managers only. A rule names the Kitchen portions one
 * Restaurant dish is expected to use; the crosscheck (C4-6) compares the
 * kitchen's entries with it. A rule never fills in a kitchen entry or moves
 * stock.
 */
@Injectable()
export class KitchenMappingService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
  ) {}

  /** `GET /staff/kitchen-mappings`: the dishes that have a rule, by name. */
  async list(query: PaginationQuery): Promise<KitchenMappingPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.MenuItemWhereInput = { kitchenMappings: { some: {} } };

    const dishes = await this.prisma.menuItem.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, slug: true, name: true },
    });
    const total = await this.prisma.menuItem.count({ where });
    const rules = await readKitchenMappings(
      this.prisma,
      dishes.map((dish) => dish.id),
    );

    return {
      data: dishes.map((dish) => ({
        menuItemId: dish.id,
        menuItemSlug: dish.slug,
        menuItemName: dish.name,
        lines: rules.get(dish.id) ?? [],
      })),
      page,
      pageSize,
      total,
    };
  }

  /**
   * `mapping.save`: replace a Restaurant dish's whole rule.
   *
   * The dish's row is locked first (`FOR UPDATE`), so two managers saving
   * the same dish's rule run one after the other and the second replaces
   * the first whole, never interleaving their portions. The rule carries no
   * `version`: A8 does not list it, and a rule is replaced, not edited.
   */
  async save(
    actor: StaffPrincipal,
    menuItemId: string,
    request: SaveKitchenMappingRequest,
    ipAddress: string,
  ): Promise<KitchenMappingResponse> {
    return this.prisma.$transaction(async (tx) => {
      const [dish] = await tx.$queryRaw<
        { id: string; slug: string; name: string; department: Department }[]
      >`
        SELECT "id", "slug", "name", "department"
          FROM "MenuItem"
         WHERE "id" = ${menuItemId}
           FOR UPDATE`;

      if (dish === undefined || dish.department !== Department.RESTAURANT) {
        throw new BadRequestException(MAPPING_FOOD_MESSAGE);
      }

      const ids = request.lines.map((line) => line.stockItemId);
      const portions = await tx.stockItem.findMany({
        where: { id: { in: ids } },
        select: { id: true, kind: true },
      });
      const kinds = new Map(portions.map((item) => [item.id, item.kind]));

      for (const id of ids) {
        if (kinds.get(id) !== StockKind.KITCHEN) {
          throw new BadRequestException(MAPPING_PORTION_MESSAGE);
        }
      }

      const before = (await readKitchenMappings(tx, [dish.id])).get(dish.id);

      await tx.kitchenMapping.deleteMany({ where: { menuItemId: dish.id } });

      await tx.kitchenMapping.createMany({
        data: request.lines.map((line) => ({
          menuItemId: dish.id,
          stockItemId: line.stockItemId,
          qty: line.qty,
        })),
      });

      const lines =
        (await readKitchenMappings(tx, [dish.id])).get(dish.id) ?? [];

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'mapping.save',
          ref: dish.slug,
          before: auditLines(before ?? []),
          after: auditLines(lines),
          ipAddress,
        },
        tx,
      );

      return {
        menuItemId: dish.id,
        menuItemSlug: dish.slug,
        menuItemName: dish.name,
        lines,
      };
    });
  }
}
