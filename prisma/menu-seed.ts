import { Department, MenuCategoryKind } from '../generated/cnc-client';
import { BAR_STOCK_SHAPE } from '../src/menu/bar-stock';
import { STAFF_ID_MAP } from './seed-data/staff-id-map';
import { STAFF_MENU, type StaffMenuItem } from './seed-data/staff-menu';
import {
  WEBSITE_MENU,
  type WebsiteCategory,
  type WebsiteChoice,
} from './seed-data/website-menu';

/**
 * The menu the seed writes, built from the three copied sources (plan §12.1):
 * the website's menu, the staff app's menu and the one-time id map between
 * them. Pure: no database, so `menu-seed.spec.ts` checks every count, price
 * and pairing without one.
 *
 * ## Which source wins
 *
 * The website is the master for everything it shows: slug, name, price,
 * description, signature, group heading and choice (`cnc-frontend/docs/
 * SHARED-CONTRACT.md` §4: "use the customer site's IDs"). The staff app adds
 * what only it knows: its id (kept as `legacyStaffId`), the staff category,
 * the department and "Available for Sale". The two must agree on every price,
 * signature and choice, and `buildMenuSeed` throws when they do not: a seed
 * that quietly picked one of two prices would be choosing a price, which is
 * the founder's call (Q7), not this script's.
 *
 * A name may differ only on a dish that carries a choice: the three dishes
 * the shared contract names ("Avocado Toast (Tuna or Eggs)" on staff,
 * "Avocado Toast" on the website, and the Whole Fish and the Wraps) moved
 * their variant into the choice, and the website's shorter name is kept.
 *
 * ## The paired Bar stock items
 *
 * Every Bar menu item gets exactly one Bar stock item (plan §4.6, §12.1):
 * named as the item, unit "serving", pack "batch", factor 12, minimum 12, the
 * values `seed()` and `menu.save` use in the staff app (`domain.ts`). Balances
 * start at zero (Q11); the stock tables that hold them arrive in C4.
 */

export interface MenuCategorySeed {
  slug: string;
  title: string;
  /** Null where the website has no note. */
  note: string | null;
  kind: MenuCategoryKind;
  sort: number;
}

export interface StaffCategorySeed {
  name: string;
  department: Department;
  menuCategorySlug: string;
}

export interface MenuItemSeed {
  slug: string;
  legacyStaffId: string;
  department: Department;
  staffCategoryName: string;
  menuCategorySlug: string;
  groupLabel: string | null;
  name: string;
  description: string;
  priceKobo: number;
  signature: boolean;
  active: boolean;
  showOnline: boolean;
  choiceLabel: string | null;
  choiceOptions: string[];
  sort: number;
}

export interface BarStockItemSeed {
  menuItemSlug: string;
  name: string;
  unit: string;
  pack: string;
  factor: number;
  minimum: number;
}

export interface MenuSeed {
  menuCategories: MenuCategorySeed[];
  staffCategories: StaffCategorySeed[];
  menuItems: MenuItemSeed[];
  barStockItems: BarStockItemSeed[];
}

export interface MenuSources {
  website: readonly WebsiteCategory[];
  staff: readonly StaffMenuItem[];
  idMap: {
    readonly dishes: Readonly<Record<string, string>>;
    readonly categories: Readonly<Record<string, string>>;
  };
}

/**
 * The paired Bar stock item's fixed shape, from `src/menu/bar-stock.ts`, the
 * one home `menu.save` shares. Re-exported so the seed's callers keep one
 * import.
 */
export { BAR_STOCK_SHAPE };

/**
 * The two customer categories that hold drinks; every other one holds food.
 * Written out rather than inferred, so a new category has to be placed on
 * purpose.
 */
const DRINK_CATEGORY_KINDS: Readonly<Record<string, MenuCategoryKind>> = {
  drinks: MenuCategoryKind.DRINKS,
  slush: MenuCategoryKind.SLUSH,
};

const DEPARTMENTS: Readonly<Record<StaffMenuItem['department'], Department>> = {
  Restaurant: Department.RESTAURANT,
  Bar: Department.BAR,
};

/** Throw with the seed's own prefix, so a refusal reads as the data's fault. */
function refuse(message: string): never {
  throw new Error(`The menu sources disagree: ${message}`);
}

function sameChoice(
  a: WebsiteChoice | undefined,
  b: WebsiteChoice | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }

  return (
    a.label === b.label &&
    a.options.length === b.options.length &&
    a.options.every((option, index) => option === b.options[index])
  );
}

/**
 * Join the sources into the rows to seed, or throw naming the first
 * disagreement. The default arguments are the copied data; the spec passes
 * altered copies to prove each refusal.
 */
export function buildMenuSeed(
  sources: MenuSources = {
    website: WEBSITE_MENU,
    staff: STAFF_MENU,
    idMap: STAFF_ID_MAP,
  },
): MenuSeed {
  const { website, staff, idMap } = sources;

  // Customer categories, in the website's order.
  const menuCategories: MenuCategorySeed[] = website.map((category, index) => ({
    slug: category.id,
    title: category.title,
    note: category.note === '' ? null : category.note,
    kind: DRINK_CATEGORY_KINDS[category.id] ?? MenuCategoryKind.FOOD,
    sort: index + 1,
  }));

  const categoryKinds = new Map(
    menuCategories.map((category) => [category.slug, category.kind]),
  );

  if (categoryKinds.size !== website.length) {
    refuse('a website category id appears twice.');
  }

  // Website dishes by slug, each with its category and its place in it.
  const dishes = new Map<
    string,
    {
      dish: WebsiteCategory['items'][number];
      categorySlug: string;
      sort: number;
    }
  >();

  for (const category of website) {
    category.items.forEach((dish, index) => {
      if (dishes.has(dish.id)) {
        refuse(`the website dish id ${dish.id} appears twice.`);
      }

      dishes.set(dish.id, { dish, categorySlug: category.id, sort: index + 1 });
    });
  }

  // Staff categories: one department each, mapped to an existing customer
  // category whose kind fits the department.
  const staffCategoryDepartments = new Map<string, Department>();

  for (const item of staff) {
    const department = DEPARTMENTS[item.department];

    if (department === undefined) {
      refuse(`${item.id} has the unknown department ${item.department}.`);
    }

    const seen = staffCategoryDepartments.get(item.category);

    if (seen !== undefined && seen !== department) {
      refuse(`the staff category ${item.category} holds both departments.`);
    }

    staffCategoryDepartments.set(item.category, department);
  }

  const staffCategories: StaffCategorySeed[] = Object.entries(
    idMap.categories,
  ).map(([name, menuCategorySlug]) => {
    const kind = categoryKinds.get(menuCategorySlug);
    const department = staffCategoryDepartments.get(name);

    if (kind === undefined) {
      refuse(
        `the staff category ${name} maps to ${menuCategorySlug}, which the website does not have.`,
      );
    }

    if (department === undefined) {
      refuse(`the staff category ${name} has no item in the staff menu.`);
    }

    const foodKind = kind === MenuCategoryKind.FOOD;

    if (foodKind !== (department === Department.RESTAURANT)) {
      refuse(
        `the staff category ${name} is ${department} but maps to the ${kind} category ${menuCategorySlug}.`,
      );
    }

    return { name, department, menuCategorySlug };
  });

  for (const name of staffCategoryDepartments.keys()) {
    if (!(name in idMap.categories)) {
      refuse(`the staff category ${name} is not in the id map.`);
    }
  }

  // Menu items: every staff item joined to exactly one website dish.
  const usedSlugs = new Set<string>();
  const menuItems: MenuItemSeed[] = [];

  for (const item of staff) {
    const slug = idMap.dishes[item.id];

    if (slug === undefined) {
      refuse(`${item.id} is not in the id map.`);
    }

    const found = dishes.get(slug);

    if (found === undefined) {
      refuse(`${item.id} maps to ${slug}, which the website does not have.`);
    }

    if (usedSlugs.has(slug)) {
      refuse(`two staff items map to ${slug}.`);
    }

    usedSlugs.add(slug);

    const { dish, categorySlug, sort } = found;

    if (idMap.categories[item.category] !== categorySlug) {
      refuse(
        `${item.id} is in ${item.category}, but ${slug} is in ${categorySlug} on the website.`,
      );
    }

    if (!Number.isInteger(dish.price) || dish.price < 0) {
      refuse(`${slug} has the price ${dish.price}, which is not whole kobo.`);
    }

    if (dish.price !== item.price) {
      refuse(
        `${slug} costs ${dish.price} kobo on the website and ${item.price} in the staff app.`,
      );
    }

    if ((dish.signature ?? false) !== item.signature) {
      refuse(`${slug} is a signature dish in one source only.`);
    }

    if (!sameChoice(dish.choice, item.choice)) {
      refuse(`${slug} offers a different choice in each source.`);
    }

    if (dish.name !== item.name && dish.choice === undefined) {
      refuse(
        `${slug} is "${dish.name}" on the website and "${item.name}" in the staff app, and has no choice to carry the difference.`,
      );
    }

    menuItems.push({
      slug,
      legacyStaffId: item.id,
      department: DEPARTMENTS[item.department],
      staffCategoryName: item.category,
      menuCategorySlug: categorySlug,
      groupLabel: dish.group ?? null,
      name: dish.name,
      description: dish.desc,
      priceKobo: dish.price,
      signature: item.signature,
      active: item.active,
      showOnline: true,
      choiceLabel: dish.choice?.label ?? null,
      choiceOptions: dish.choice ? [...dish.choice.options] : [],
      sort,
    });
  }

  for (const slug of dishes.keys()) {
    if (!usedSlugs.has(slug)) {
      refuse(`the website dish ${slug} has no staff item.`);
    }
  }

  // One Bar stock item per Bar menu item. Names are unique ignoring case,
  // as the StockItem index requires.
  const barStockItems: BarStockItemSeed[] = menuItems
    .filter((item) => item.department === Department.BAR)
    .map((item) => ({
      menuItemSlug: item.slug,
      name: item.name,
      ...BAR_STOCK_SHAPE,
    }));

  const stockNames = new Set(
    barStockItems.map((item) => item.name.toLowerCase()),
  );

  if (stockNames.size !== barStockItems.length) {
    refuse('two Bar items share a name, so their stock items would clash.');
  }

  return { menuCategories, staffCategories, menuItems, barStockItems };
}
