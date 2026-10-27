import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ACCOUNT_GONE_MESSAGE } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { formatIsoDate } from '../common/calendar-date';
import { watToday } from '../common/wat';
import { PhotoStore } from '../images/photo-store.service';
import { MENU_ORDER, MenuService, readMenuItems } from '../menu/menu.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { OpeningHoursService } from '../settings/opening-hours.service';
import { SettingsService } from '../settings/settings.service';
import { readKitchenMappings } from '../stock/kitchen-mapping.service';
import type { OverviewPreferencesDto } from './dto/overview-preferences.dto';
import type { ReferenceResponse } from './dto/reference.response';
import type { StaffMeResponse } from './dto/staff-me.response';
import {
  normalisePreferences,
  type OverviewPreferences,
} from './overview-preferences';
import { pagesFor } from './staff-pages';

/**
 * The staff app's shell (plan §5.3, card C3-8): who is signed in, the
 * reference data every screen looks things up in, and the person's own
 * overview layout.
 */
@Injectable()
export class ShellService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly photos: PhotoStore,
    private readonly settings: SettingsService,
    private readonly hours: OpeningHoursService,
    private readonly menu: MenuService,
  ) {}

  /** `GET /staff/me`. */
  async me(actor: StaffPrincipal): Promise<StaffMeResponse> {
    const row = await this.prisma.staff.findUnique({
      where: { id: actor.id },
      select: {
        id: true,
        staffNo: true,
        name: true,
        email: true,
        role: true,
        mustChangePassword: true,
        photo: true,
        joinedOn: true,
        version: true,
      },
    });

    // The guard has just read this row; this covers a delete in between.
    if (row === null) throw new UnauthorizedException(ACCOUNT_GONE_MESSAGE);

    return {
      id: row.id,
      staffNo: row.staffNo,
      name: row.name,
      email: row.email,
      role: row.role,
      mustChangePassword: row.mustChangePassword,
      pages: pagesFor(row.role),
      photoUrl: await this.photos.signedUrlOrNull(row.photo),
      joinedOn: formatIsoDate(row.joinedOn),
      version: row.version,
    };
  }

  /**
   * `GET /staff/reference`, read in one transaction so every part is from
   * the same moment: a menu item and the category it names never disagree.
   * Every read is a plain query awaited in turn, never a nested relation
   * select (see `readMenuItems`), so the transaction's one connection runs
   * one query at a time.
   */
  async reference(actor: StaffPrincipal): Promise<ReferenceResponse> {
    const readsAssets = pagesFor(actor.role).includes('maintenance');
    const read = await this.prisma.$transaction(async (tx) => ({
      settings: await this.settings.readSettings(tx),
      business: await this.settings.readBusiness(tx),
      openingHours: await this.hours.read(tx),
      venues: await tx.venue.findMany({
        orderBy: [{ sort: 'asc' }, { slug: 'asc' }],
        select: {
          id: true,
          slug: true,
          customerTitle: true,
          staffName: true,
          bigParty: true,
          sort: true,
        },
      }),
      tables: await tx.diningTable.findMany({
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          venueId: true,
          code: true,
          name: true,
          kind: true,
          capacity: true,
          active: true,
        },
      }),
      menuCategories: await tx.menuCategory.findMany({
        orderBy: [{ sort: 'asc' }, { slug: 'asc' }],
        select: {
          id: true,
          slug: true,
          title: true,
          note: true,
          kind: true,
          sort: true,
        },
      }),
      staffCategories: await tx.staffCategory.findMany({
        orderBy: [{ department: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          department: true,
          menuCategoryId: true,
        },
      }),
      menu: await readMenuItems(tx, { orderBy: MENU_ORDER }),
      stockItems: await tx.stockItem.findMany({
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          kind: true,
          unit: true,
          pack: true,
          factor: true,
          minimum: true,
          menuItemId: true,
          active: true,
          version: true,
        },
      }),
      kitchenMappings: await readKitchenMappings(tx),
      staff: await tx.staff.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          staffNo: true,
          name: true,
          role: true,
          isActive: true,
        },
      }),
      // The lite list (C5-3): what a form picks a vendor from and a record
      // names one by. Contact details stay on the Vendors screen's read.
      vendors: await tx.vendor.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, service: true, isActive: true },
      }),
      // The lite list (C5-6), for the roles that open Assets & Maintenance
      // (Reception and managers, plan §5.3): what a repair form picks an
      // asset from and a repair names one by. Everyone else gets none.
      assets: readsAssets
        ? await tx.asset.findMany({
            orderBy: [{ tag: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              tag: true,
              name: true,
              location: true,
              status: true,
            },
          })
        : [],
    }));

    const { tables, kitchenMappings, ...rest } = read;

    return {
      ...rest,
      // In menu order, so the rules list as the dishes do.
      kitchenMappings: read.menu
        .filter((item) => kitchenMappings.has(item.id))
        .map((item) => ({
          menuItemId: item.id,
          lines: (kitchenMappings.get(item.id) ?? []).map((line) => ({
            stockItemId: line.stockItemId,
            qty: line.qty,
          })),
        })),
      venues: read.venues.map((venue) => ({
        ...venue,
        tables: tables
          .filter((table) => table.venueId === venue.id)
          .map((table) => ({
            id: table.id,
            code: table.code,
            name: table.name,
            kind: table.kind,
            capacity: table.capacity,
            active: table.active,
          })),
      })),
      menu: await Promise.all(
        read.menu.map((row) => this.menu.toResponse(row)),
      ),
    };
  }

  /**
   * `GET /staff/me/preferences/overview`: the stored layout made whole, or
   * the Service preset for today when none is stored.
   */
  async overviewPreferences(
    actor: StaffPrincipal,
  ): Promise<OverviewPreferences> {
    const row = await this.prisma.staff.findUnique({
      where: { id: actor.id },
      select: { overviewPrefs: true },
    });

    return normalisePreferences(row?.overviewPrefs ?? null, this.today());
  }

  /**
   * `PUT /staff/me/preferences/overview`: store the person's layout, made
   * whole first, so what is stored is what the next read answers.
   *
   * Not a versioned write and not audited, deliberately: the layout is one
   * person's view of their own dashboard, not a record two people edit, so
   * the last save wins; and moving `Staff.version` would make a manager's
   * edit of the account stale because its holder rearranged a dashboard.
   */
  async saveOverviewPreferences(
    actor: StaffPrincipal,
    request: OverviewPreferencesDto,
  ): Promise<OverviewPreferences> {
    const preferences = normalisePreferences(
      {
        version: request.version,
        widgets: request.widgets.map((widget) => ({
          id: widget.id,
          visible: widget.visible,
          wide: widget.wide,
        })),
        period: request.period,
        from: request.from,
        to: request.to,
      },
      this.today(),
    );

    await this.prisma.staff.update({
      where: { id: actor.id },
      data: {
        overviewPrefs: JSON.parse(JSON.stringify(preferences)) as object,
      },
      select: { id: true },
    });

    return preferences;
  }

  private today(): string {
    return formatIsoDate(watToday(new Date()));
  }
}
