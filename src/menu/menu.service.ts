import { BadRequestException, Injectable } from '@nestjs/common';
import { Department, type Prisma, StockKind } from '../../generated/cnc-client';
import { AuditService, staffActor } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import {
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
} from '../common/dto/pagination.query';
import {
  PhotoStore,
  type StoredMenuPhoto,
} from '../images/photo-store.service';
import type { UploadedImageFile } from '../images/uploaded-image';
import {
  MoneyControlService,
  OWNER_ONLY_NEW_MENU_ITEM_MESSAGE,
  OWNER_ONLY_PRICE_MESSAGE,
} from '../money-control/money-control.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { claimVersion } from '../prisma/optimistic-version';
import { assertStockNameFree } from '../stock/stock-item-name';
import { BAR_STOCK_SHAPE } from './bar-stock';
import type {
  CreateMenuItemRequest,
  UpdateMenuItemRequest,
} from './dto/menu-item.request';
import type {
  MenuItemResponse,
  MenuListQuery,
  MenuPageResponse,
} from './dto/menu-item.response';
import type {
  PublicMenuItemResponse,
  PublicMenuResponse,
} from './dto/public-menu.response';
import {
  MENU_CATEGORY_MESSAGE,
  MENU_ITEM_NOT_FOUND_MESSAGE,
} from './menu-messages';
import { uniqueSlug } from './menu-slug';

/** The item's own columns an item is answered and audited from. */
const MENU_ITEM_COLUMNS = {
  id: true,
  slug: true,
  legacyStaffId: true,
  department: true,
  staffCategoryId: true,
  menuCategoryId: true,
  groupLabel: true,
  name: true,
  description: true,
  priceKobo: true,
  signature: true,
  active: true,
  showOnline: true,
  photo: true,
  photoAlt: true,
  choiceLabel: true,
  choiceOptions: true,
  sort: true,
  version: true,
} satisfies Prisma.MenuItemSelect;

/** An item with the names its screens show beside it. */
export type MenuItemRow = Prisma.MenuItemGetPayload<{
  select: typeof MENU_ITEM_COLUMNS;
}> & {
  staffCategoryName: string;
  menuCategorySlug: string;
  /** The paired Bar stock item; null for a Restaurant item. */
  stockItemId: string | null;
};

type Tx = Prisma.TransactionClient;

/** The tables an item read touches, on the base client or a transaction. */
type MenuReader = Pick<
  Tx,
  'menuItem' | 'staffCategory' | 'menuCategory' | 'stockItem'
>;

/**
 * Items with their category names and paired stock item, in four plain
 * queries run one after another.
 *
 * Not a nested `select` of the relations: inside an interactive
 * transaction Prisma 7 sends a nested select's queries on the
 * transaction's one connection at the same time, which `pg` 8 queues with
 * a deprecation warning and `pg` 9 will refuse. Sequential reads keep every
 * command's transaction on one query at a time.
 */
export async function readMenuItems(
  client: MenuReader,
  args: Omit<Prisma.MenuItemFindManyArgs, 'select' | 'include'> = {},
): Promise<MenuItemRow[]> {
  const items = await client.menuItem.findMany({
    ...args,
    select: MENU_ITEM_COLUMNS,
  });

  if (items.length === 0) return [];

  const staffCategories = await client.staffCategory.findMany({
    where: { id: { in: [...new Set(items.map((i) => i.staffCategoryId))] } },
    select: { id: true, name: true },
  });
  const menuCategories = await client.menuCategory.findMany({
    where: { id: { in: [...new Set(items.map((i) => i.menuCategoryId))] } },
    select: { id: true, slug: true },
  });
  const stock = await client.stockItem.findMany({
    where: { menuItemId: { in: items.map((i) => i.id) } },
    select: { id: true, menuItemId: true },
  });

  const staffNames = new Map(staffCategories.map((c) => [c.id, c.name]));
  const menuSlugs = new Map(menuCategories.map((c) => [c.id, c.slug]));
  const stockIds = new Map(stock.map((s) => [s.menuItemId, s.id]));

  return items.map((item) => ({
    ...item,
    staffCategoryName: staffNames.get(item.staffCategoryId) ?? '',
    menuCategorySlug: menuSlugs.get(item.menuCategoryId) ?? '',
    stockItemId: stockIds.get(item.id) ?? null,
  }));
}

/** One item, which the caller knows exists (it holds the row). */
async function readMenuItem(client: MenuReader, id: string) {
  const [row] = await readMenuItems(client, { where: { id } });

  if (row === undefined) {
    throw new Error(`Menu item ${id} vanished inside its own transaction.`);
  }

  return row;
}

/** The order Menu & Prices lists items in: department, category, sort. */
export const MENU_ORDER: Prisma.MenuItemOrderByWithRelationInput[] = [
  { department: 'asc' },
  { menuCategory: { sort: 'asc' } },
  { sort: 'asc' },
  { name: 'asc' },
  { id: 'asc' },
];

/**
 * What an audit row records of an item: the fields staff read in the
 * history, the category by name, and whether there is a photo (the demo's
 * `hasPhoto`), never the `gs://` URI.
 */
function auditView(row: MenuItemRow) {
  return {
    name: row.name,
    department: row.department,
    category: row.staffCategoryName,
    description: row.description,
    priceKobo: row.priceKobo,
    active: row.active,
    showOnline: row.showOnline,
    photoAlt: row.photoAlt,
    hasPhoto: row.photo !== null,
  };
}

/**
 * Menu & Prices (plan §5.4, card C3-7): the demo's `menu.save`, with the
 * photo moved to its own routes (A17).
 *
 * - **Managers** change names, descriptions, categories, availability,
 *   Show Online and photos.
 * - **The Owner** alone adds an item ("…because every item needs a price")
 *   and changes a price ("Only the Owner can change a price."), through
 *   `MoneyControlService.requireOwner`.
 * - **A new Bar item gets its paired Bar stock item in the same
 *   transaction** (`domain.ts`, plan §4.6), so no drink can be sold that
 *   stock cannot count.
 *
 * Each command is one transaction (A6): `claimVersion` first for an edit
 * (A8), the audit row through the same transaction.
 */
@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly audit: AuditService,
    private readonly money: MoneyControlService,
    private readonly photos: PhotoStore,
  ) {}

  /** `GET /staff/menu`: a page of items, in menu order. */
  async list(query: MenuListQuery): Promise<MenuPageResponse> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const q = query.q?.trim();

    const where: Prisma.MenuItemWhereInput = {
      ...(query.department ? { department: query.department } : {}),
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    };

    const rows = await readMenuItems(this.prisma, {
      where,
      orderBy: MENU_ORDER,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    const total = await this.prisma.menuItem.count({ where });

    return {
      data: await Promise.all(rows.map((row) => this.toResponse(row))),
      page,
      pageSize,
      total,
    };
  }

  /**
   * The Owner's refusal for a new item, checked before the idempotent
   * transaction opens, so a Manager's attempt never takes a key.
   */
  assertMayCreate(actor: StaffPrincipal): void {
    this.money.requireOwner(actor, OWNER_ONLY_NEW_MENU_ITEM_MESSAGE);
  }

  /**
   * `menu.save` adding an item, inside the caller's transaction (the
   * idempotency service's). The slug comes from the name and is never
   * reused; the item goes last in its customer category.
   */
  async create(
    tx: Tx,
    actor: StaffPrincipal,
    request: CreateMenuItemRequest,
    ipAddress: string,
  ): Promise<MenuItemResponse> {
    this.assertMayCreate(actor);

    const category = await this.staffCategory(
      tx,
      request.staffCategoryId,
      request.department,
    );

    if (request.department === Department.BAR) {
      await assertStockNameFree(tx, request.name);
    }

    const slug = await uniqueSlug(tx, request.name);
    const sort = await this.nextSort(tx, category.menuCategoryId);

    const created = await tx.menuItem.create({
      data: {
        slug,
        department: request.department,
        staffCategoryId: request.staffCategoryId,
        menuCategoryId: category.menuCategoryId,
        name: request.name,
        description: request.description ?? '',
        priceKobo: request.priceKobo,
        active: request.active ?? true,
        showOnline: request.showOnline ?? true,
        photoAlt: request.photoAlt || null,
        sort,
      },
      select: { id: true },
    });

    if (request.department === Department.BAR) {
      await tx.stockItem.create({
        data: {
          name: request.name,
          kind: StockKind.BAR,
          ...BAR_STOCK_SHAPE,
          menuItemId: created.id,
        },
      });
    }

    const row = await readMenuItem(tx, created.id);

    await this.audit.record(
      {
        actor: staffActor(actor),
        action: 'menu.save',
        ref: row.slug,
        before: null,
        after: auditView(row),
        ipAddress,
      },
      tx,
    );

    return this.toResponse(row);
  }

  /**
   * `menu.save` changing an item. A price that differs from the stored one
   * is the Owner's; sending the price unchanged is allowed, as the demo's
   * form sends it. Moving to another staff category moves the item to that
   * category's customer category, at its end, and never to the other
   * department.
   *
   * A Bar item's paired stock item keeps its name when the item is renamed,
   * as in the demo: the stock item is renamed, if at all, in Stock &
   * Requests (`stockitem.save`, C4).
   */
  async update(
    actor: StaffPrincipal,
    id: string,
    request: UpdateMenuItemRequest,
    ipAddress: string,
  ): Promise<MenuItemResponse> {
    const row = await this.prisma.$transaction(async (tx) => {
      await claimVersion(tx, {
        table: 'MenuItem',
        id,
        version: request.version,
        notFound: MENU_ITEM_NOT_FOUND_MESSAGE,
      });

      const current = await readMenuItem(tx, id);

      if (
        request.priceKobo !== undefined &&
        request.priceKobo !== current.priceKobo
      ) {
        this.money.requireOwner(actor, OWNER_ONLY_PRICE_MESSAGE);
      }

      const data: Prisma.MenuItemUncheckedUpdateInput = {};

      if (
        request.staffCategoryId !== undefined &&
        request.staffCategoryId !== current.staffCategoryId
      ) {
        const category = await this.staffCategory(
          tx,
          request.staffCategoryId,
          current.department,
        );

        data.staffCategoryId = request.staffCategoryId;

        if (category.menuCategoryId !== current.menuCategoryId) {
          data.menuCategoryId = category.menuCategoryId;
          data.sort = await this.nextSort(tx, category.menuCategoryId);
        }
      }

      if (request.name !== undefined) data.name = request.name;
      if (request.priceKobo !== undefined) data.priceKobo = request.priceKobo;
      if (request.description !== undefined) {
        data.description = request.description;
      }
      if (request.active !== undefined) data.active = request.active;
      if (request.showOnline !== undefined) {
        data.showOnline = request.showOnline;
      }
      if (request.photoAlt !== undefined) {
        data.photoAlt = request.photoAlt === '' ? null : request.photoAlt;
      }

      await tx.menuItem.update({ where: { id }, data, select: { id: true } });
      const updated = await readMenuItem(tx, id);

      await this.audit.record(
        {
          actor: staffActor(actor),
          action: 'menu.save',
          ref: updated.slug,
          before: auditView(current),
          after: auditView(updated),
          ipAddress,
        },
        tx,
      );

      return updated;
    });

    return this.toResponse(row);
  }

  /**
   * Replace an item's photo (managers; resized to fit 800 pixels), with
   * its 240 pixel thumbnail for the public menu's list views (B2).
   */
  async replacePhoto(
    actor: StaffPrincipal,
    id: string,
    version: number,
    file: UploadedImageFile | undefined,
    ipAddress: string,
  ): Promise<MenuItemResponse> {
    const stored = await this.photos.storeMenuPhoto(id, file);

    return this.writePhoto(actor, id, version, stored, ipAddress);
  }

  /** Remove an item's photo (managers). */
  removePhoto(
    actor: StaffPrincipal,
    id: string,
    version: number,
    ipAddress: string,
  ): Promise<MenuItemResponse> {
    return this.writePhoto(actor, id, version, null, ipAddress);
  }

  /**
   * Point the item at a new photo and thumbnail, or none, and tidy the
   * bucket afterwards (see `PhotoStore` for the order). The two move
   * together, so the thumbnail is always of the photo beside it.
   */
  private async writePhoto(
    actor: StaffPrincipal,
    id: string,
    version: number,
    stored: StoredMenuPhoto | null,
    ipAddress: string,
  ): Promise<MenuItemResponse> {
    const photo = stored?.photo ?? null;
    const photoThumb = stored?.thumb ?? null;
    let result: {
      row: MenuItemRow;
      replaced: { photo: string | null; photoThumb: string | null };
    };

    try {
      result = await this.prisma.$transaction(async (tx) => {
        await claimVersion(tx, {
          table: 'MenuItem',
          id,
          version,
          notFound: MENU_ITEM_NOT_FOUND_MESSAGE,
        });

        const current = await tx.menuItem.findUniqueOrThrow({
          where: { id },
          select: { photo: true, photoThumb: true },
        });

        await tx.menuItem.update({
          where: { id },
          data: { photo, photoThumb },
          select: { id: true },
        });
        const row = await readMenuItem(tx, id);

        await this.audit.record(
          {
            actor: staffActor(actor),
            action: 'menu.photo',
            ref: row.slug,
            before: { hasPhoto: current.photo !== null },
            after: { hasPhoto: photo !== null },
            ipAddress,
          },
          tx,
        );

        return { row, replaced: current };
      });
    } catch (error) {
      await this.photos.removeQuietly(photo);
      await this.photos.removeQuietly(photoThumb);
      throw error;
    }

    if (result.replaced.photo !== photo) {
      await this.photos.removeQuietly(result.replaced.photo);
    }
    if (result.replaced.photoThumb !== photoThumb) {
      await this.photos.removeQuietly(result.replaced.photoThumb);
    }

    return this.toResponse(result.row);
  }

  /** The staff category, which must exist and match the department. */
  private async staffCategory(
    tx: Tx,
    staffCategoryId: string,
    department: Department,
  ): Promise<{ menuCategoryId: string }> {
    const category = await tx.staffCategory.findUnique({
      where: { id: staffCategoryId },
      select: { department: true, menuCategoryId: true },
    });

    if (category === null || category.department !== department) {
      throw new BadRequestException(MENU_CATEGORY_MESSAGE);
    }

    return { menuCategoryId: category.menuCategoryId };
  }

  /** One past the last `sort` in a customer category. */
  private async nextSort(tx: Tx, menuCategoryId: string): Promise<number> {
    const { _max } = await tx.menuItem.aggregate({
      where: { menuCategoryId },
      _max: { sort: true },
    });

    return (_max.sort ?? 0) + 1;
  }

  /**
   * `GET /menu` (plan §5.1, C6-4): what the website and the order page
   * list. Only items that are Available for Sale and Show Online (Q37's
   * default: an unavailable dish is hidden, with no "Sold out" state), in
   * the customer categories' order, the category's dishes by `sort`; a
   * category left with none is not listed. Photos and their thumbnails are
   * signed for an hour and the links reused while 45 minutes remain
   * (`PhotoStore.publicSignedUrlOrNull`), because the answer is cached.
   * Two queries, and nothing remembered between reads but those links, so
   * a price or availability change shows on the very next read.
   */
  async publicMenu(): Promise<PublicMenuResponse> {
    const categories = await this.prisma.menuCategory.findMany({
      orderBy: [{ sort: 'asc' }, { slug: 'asc' }],
      select: { id: true, slug: true, title: true, note: true, kind: true },
    });
    const items = await this.prisma.menuItem.findMany({
      where: { active: true, showOnline: true },
      orderBy: [{ sort: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      select: {
        menuCategoryId: true,
        slug: true,
        name: true,
        description: true,
        priceKobo: true,
        signature: true,
        groupLabel: true,
        choiceLabel: true,
        choiceOptions: true,
        photo: true,
        photoThumb: true,
        photoAlt: true,
      },
    });

    const answered = await Promise.all(
      items.map(async (item) => ({
        menuCategoryId: item.menuCategoryId,
        response: {
          slug: item.slug,
          name: item.name,
          description: item.description,
          priceKobo: item.priceKobo,
          signature: item.signature,
          group: item.groupLabel,
          choice:
            item.choiceLabel !== null && item.choiceOptions.length > 0
              ? { label: item.choiceLabel, options: item.choiceOptions }
              : null,
          photoUrl: await this.photos.publicSignedUrlOrNull(item.photo),
          // Never a thumbnail without the photo it was made from.
          thumbUrl:
            item.photo === null
              ? null
              : await this.photos.publicSignedUrlOrNull(item.photoThumb),
          photoAlt: item.photoAlt,
        } satisfies PublicMenuItemResponse,
      })),
    );

    return {
      categories: categories
        .map((category) => ({
          slug: category.slug,
          title: category.title,
          note: category.note,
          kind: category.kind,
          items: answered
            .filter((item) => item.menuCategoryId === category.id)
            .map((item) => item.response),
        }))
        .filter((category) => category.items.length > 0),
    };
  }

  /** The row as the API answers it, field by field, with a signed photo. */
  async toResponse(row: MenuItemRow): Promise<MenuItemResponse> {
    return {
      id: row.id,
      slug: row.slug,
      legacyStaffId: row.legacyStaffId,
      department: row.department,
      staffCategoryId: row.staffCategoryId,
      staffCategoryName: row.staffCategoryName,
      menuCategoryId: row.menuCategoryId,
      menuCategorySlug: row.menuCategorySlug,
      groupLabel: row.groupLabel,
      name: row.name,
      description: row.description,
      priceKobo: row.priceKobo,
      signature: row.signature,
      active: row.active,
      showOnline: row.showOnline,
      photoUrl: await this.photos.signedUrlOrNull(row.photo),
      photoAlt: row.photoAlt,
      choiceLabel: row.choiceLabel,
      choiceOptions: row.choiceOptions,
      sort: row.sort,
      stockItemId: row.stockItemId,
      version: row.version,
    };
  }
}
