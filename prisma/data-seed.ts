import { StockKind, type PrismaClient } from '../generated/cnc-client';
import { buildMenuSeed, type MenuSeed } from './menu-seed';
import { BUSINESS, SETTINGS, VENUES } from './seed-data/reference';

/**
 * Writes CNC's reference data and menu (plan §12.1, C3-2): the settings row,
 * the business details, the rooms and tables, the customer and staff
 * categories, the 166 menu items and one Bar stock item per Bar item.
 *
 * ## Insert what is missing, never overwrite
 *
 * Every write is `createMany({ skipDuplicates: true })`, which is
 * `INSERT … ON CONFLICT DO NOTHING` keyed on each table's natural key
 * (a venue's slug, a table's room and code, a dish's slug, a stock item's
 * menu item). So a re-run changes nothing: no row is updated, no `version`
 * moves, no `updatedAt` is touched. That is the point, not a shortcut. Once
 * the Owner has changed a price or a manager a description in the staff app,
 * the database is the record, and a seed that wrote its values again would
 * quietly undo their work. A missing row (a fresh database, or a table added
 * by a later card) is filled in.
 *
 * ## One transaction
 *
 * Everything is written in one transaction, then checked in it: every Bar
 * item seeded here must have its stock item (a stock item someone created
 * with the same name would have blocked the insert), and the week's opening
 * hours must be there. A failed check rolls the whole run back rather than
 * leaving a menu with an unpaired Bar item.
 *
 * Opening hours are not written here. The C3 core migration seeds them
 * (480 to 1440 every day, plan §4.1, D26), and a second writer of the same
 * values would be a second place to change them.
 *
 * No audit row: this is the initial state, not anybody's action, as the
 * migration says of the opening hours.
 */

/** How many rows of one kind this run created, and how many were there already. */
export interface SeedCount {
  created: number;
  present: number;
}

export interface DataSeedReport {
  settings: SeedCount;
  business: SeedCount;
  venues: SeedCount;
  tables: SeedCount;
  menuCategories: SeedCount;
  staffCategories: SeedCount;
  menuItems: SeedCount;
  barStockItems: SeedCount;
  /** Days of opening hours present (seeded by the migration, not here). */
  openingHoursDays: number;
}

/** A Bar item with no paired stock item after the run, by slug. */
export class UnpairedBarItemsError extends Error {
  constructor(readonly slugs: string[]) {
    super(
      `These Bar menu items have no paired Bar stock item: ${slugs.join(', ')}. ` +
        `A stock item with the same name (ignoring case) probably exists ` +
        `already; rename one of the two in the staff app and run the seed again.`,
    );
  }
}

function count(created: number, total: number): SeedCount {
  return { created, present: total - created };
}

/** Map each row's natural key to its id, refusing a key the database lacks. */
function idsBy<K extends string>(
  rows: ({ id: string } & Record<K, string>)[],
  key: K,
  wanted: readonly string[],
  what: string,
): Map<string, string> {
  const ids = new Map<string, string>(
    rows.map((row): [string, string] => [row[key], row.id]),
  );

  for (const value of wanted) {
    if (!ids.has(value)) {
      // Unreachable after the insert above it, unless a row was removed
      // between the two statements of this transaction.
      throw new Error(`The ${what} ${value} is missing after seeding.`);
    }
  }

  return ids;
}

/** Days in a week of opening hours. */
const DAYS_IN_A_WEEK = 7;

/**
 * Seed the reference data and the menu, inserting only what is missing.
 * `menu` defaults to the copied sources; it is a parameter for the e2e spec.
 */
export async function seedData(
  prisma: PrismaClient,
  menu: MenuSeed = buildMenuSeed(),
): Promise<DataSeedReport> {
  return prisma.$transaction(
    async (tx) => {
      const settings = await tx.settings.createMany({
        data: [{ singleton: true, ...SETTINGS }],
        skipDuplicates: true,
      });

      const business = await tx.business.createMany({
        data: [
          {
            singleton: true,
            ...BUSINESS,
            addressLines: [...BUSINESS.addressLines],
          },
        ],
        skipDuplicates: true,
      });

      // Rooms, then their tables.
      const venueSlugs = VENUES.map((venue) => venue.slug);
      const venues = await tx.venue.createMany({
        data: VENUES.map((venue) => ({
          slug: venue.slug,
          customerTitle: venue.customerTitle,
          staffName: venue.staffName,
          bigParty: venue.bigParty,
          sort: venue.sort,
        })),
        skipDuplicates: true,
      });
      const venueIds = idsBy(
        await tx.venue.findMany({
          where: { slug: { in: venueSlugs } },
          select: { id: true, slug: true },
        }),
        'slug',
        venueSlugs,
        'room',
      );

      const tableRows = VENUES.flatMap((venue) =>
        venue.tables.map((table) => ({
          ...table,
          venueId: venueIds.get(venue.slug)!,
        })),
      );
      const tables = await tx.diningTable.createMany({
        data: tableRows,
        skipDuplicates: true,
      });

      // Customer categories, staff categories, then the dishes.
      const categorySlugs = menu.menuCategories.map(
        (category) => category.slug,
      );
      const menuCategories = await tx.menuCategory.createMany({
        data: menu.menuCategories,
        skipDuplicates: true,
      });
      const categoryIds = idsBy(
        await tx.menuCategory.findMany({
          where: { slug: { in: categorySlugs } },
          select: { id: true, slug: true },
        }),
        'slug',
        categorySlugs,
        'menu category',
      );

      const staffCategoryNames = menu.staffCategories.map(
        (category) => category.name,
      );
      const staffCategories = await tx.staffCategory.createMany({
        data: menu.staffCategories.map(({ menuCategorySlug, ...category }) => ({
          ...category,
          menuCategoryId: categoryIds.get(menuCategorySlug)!,
        })),
        skipDuplicates: true,
      });
      const staffCategoryIds = idsBy(
        await tx.staffCategory.findMany({
          where: { name: { in: staffCategoryNames } },
          select: { id: true, name: true },
        }),
        'name',
        staffCategoryNames,
        'staff category',
      );

      const itemSlugs = menu.menuItems.map((item) => item.slug);
      const menuItems = await tx.menuItem.createMany({
        data: menu.menuItems.map(
          ({ menuCategorySlug, staffCategoryName, ...item }) => ({
            ...item,
            menuCategoryId: categoryIds.get(menuCategorySlug)!,
            staffCategoryId: staffCategoryIds.get(staffCategoryName)!,
          }),
        ),
        skipDuplicates: true,
      });
      const itemIds = idsBy(
        await tx.menuItem.findMany({
          where: { slug: { in: itemSlugs } },
          select: { id: true, slug: true },
        }),
        'slug',
        itemSlugs,
        'menu item',
      );

      // One Bar stock item per Bar menu item. A conflict on the menu item
      // means the pair exists; a conflict on the name means some other item
      // holds it, which the check below turns into a refusal.
      const barStockItems = await tx.stockItem.createMany({
        data: menu.barStockItems.map(({ menuItemSlug, ...item }) => ({
          ...item,
          kind: StockKind.BAR,
          menuItemId: itemIds.get(menuItemSlug)!,
        })),
        skipDuplicates: true,
      });

      const barSlugs = menu.barStockItems.map((item) => item.menuItemSlug);
      const unpaired = await tx.menuItem.findMany({
        where: { slug: { in: barSlugs }, stockItem: { is: null } },
        select: { slug: true },
        orderBy: { slug: 'asc' },
      });

      if (unpaired.length > 0) {
        throw new UnpairedBarItemsError(unpaired.map((item) => item.slug));
      }

      const openingHoursDays = await tx.openingHoursDay.count();

      if (openingHoursDays !== DAYS_IN_A_WEEK) {
        throw new Error(
          `Expected ${DAYS_IN_A_WEEK} days of opening hours and found ` +
            `${openingHoursDays}. The C3 core migration seeds them; has it ` +
            `been applied to this database?`,
        );
      }

      return {
        settings: count(settings.count, 1),
        business: count(business.count, 1),
        venues: count(venues.count, VENUES.length),
        tables: count(tables.count, tableRows.length),
        menuCategories: count(menuCategories.count, menu.menuCategories.length),
        staffCategories: count(
          staffCategories.count,
          menu.staffCategories.length,
        ),
        menuItems: count(menuItems.count, menu.menuItems.length),
        barStockItems: count(barStockItems.count, menu.barStockItems.length),
        openingHoursDays,
      };
    },
    // A few hundred rows in a dozen statements: well inside Prisma's default
    // 5 s on a laptop, not always on a cold connection through the proxy.
    { timeout: 60_000 },
  );
}
