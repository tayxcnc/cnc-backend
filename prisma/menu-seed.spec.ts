import { buildMenuSeed, type MenuSources } from './menu-seed';
import { STAFF_ID_MAP } from './seed-data/staff-id-map';
import { STAFF_MENU } from './seed-data/staff-menu';
import { WEBSITE_MENU } from './seed-data/website-menu';

/**
 * The menu the seed writes, checked without a database: the counts the plan
 * states (§4.1, §4.6, §12.1), the prices in kobo, the Bar pairing, and each
 * refusal when the sources disagree.
 */
describe('buildMenuSeed', () => {
  const seed = buildMenuSeed();
  const bySlug = new Map(seed.menuItems.map((item) => [item.slug, item]));
  const item = (slug: string) => {
    const found = bySlug.get(slug);

    if (found === undefined) {
      throw new Error(`No seeded item ${slug}`);
    }

    return found;
  };

  /** A deep copy of the real sources, for a test to alter. */
  function sources(): MenuSources {
    return structuredClone<MenuSources>({
      website: WEBSITE_MENU,
      staff: STAFF_MENU,
      idMap: STAFF_ID_MAP,
    });
  }

  describe('counts', () => {
    it('has the 12 customer categories in the website order: 10 food, drinks and slush', () => {
      expect(seed.menuCategories.map((category) => category.slug)).toEqual([
        'breakfast',
        'soups-and-salads',
        'starters',
        'global-signatures',
        'pasta-and-fusion',
        'street-and-social',
        'the-grill',
        'sides-and-sauces',
        'for-the-little-ones',
        'something-sweet',
        'drinks',
        'slush',
      ]);
      expect(seed.menuCategories.map((category) => category.sort)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
      expect(
        seed.menuCategories.filter((category) => category.kind === 'FOOD'),
      ).toHaveLength(10);
      expect(
        seed.menuCategories.find((category) => category.slug === 'drinks')
          ?.kind,
      ).toBe('DRINKS');
      expect(
        seed.menuCategories.find((category) => category.slug === 'slush')?.kind,
      ).toBe('SLUSH');
    });

    it('has the 25 staff categories: 13 Restaurant and 12 Bar', () => {
      expect(seed.staffCategories).toHaveLength(25);
      expect(
        seed.staffCategories.filter(
          (category) => category.department === 'RESTAURANT',
        ),
      ).toHaveLength(13);
      expect(
        seed.staffCategories.filter(
          (category) => category.department === 'BAR',
        ),
      ).toHaveLength(12);
    });

    it('has 166 items: 79 food, 73 drinks and 14 slush', () => {
      const inKind = (kind: string) => {
        const slugs = new Set(
          seed.menuCategories
            .filter((category) => category.kind === kind)
            .map((category) => category.slug),
        );

        return seed.menuItems.filter((menuItem) =>
          slugs.has(menuItem.menuCategorySlug),
        );
      };

      expect(seed.menuItems).toHaveLength(166);
      expect(inKind('FOOD')).toHaveLength(79);
      expect(inKind('DRINKS')).toHaveLength(73);
      expect(inKind('SLUSH')).toHaveLength(14);
    });

    it('puts every food item in the Restaurant and every drink and slush at the Bar', () => {
      const restaurant = seed.menuItems.filter(
        (menuItem) => menuItem.department === 'RESTAURANT',
      );
      const bar = seed.menuItems.filter(
        (menuItem) => menuItem.department === 'BAR',
      );

      expect(restaurant).toHaveLength(79);
      expect(bar).toHaveLength(87);
      expect(
        bar.every((menuItem) =>
          ['drinks', 'slush'].includes(menuItem.menuCategorySlug),
        ),
      ).toBe(true);
    });

    it('gives 11 items a choice, with a label and at least two options', () => {
      const withChoice = seed.menuItems.filter(
        (menuItem) => menuItem.choiceOptions.length > 0,
      );

      expect(withChoice).toHaveLength(11);

      for (const menuItem of withChoice) {
        expect(menuItem.choiceLabel).toEqual(expect.any(String));
        expect(menuItem.choiceOptions.length).toBeGreaterThanOrEqual(2);
      }

      expect(
        seed.menuItems
          .filter((menuItem) => menuItem.choiceOptions.length === 0)
          .every((menuItem) => menuItem.choiceLabel === null),
      ).toBe(true);
    });

    it('keeps slugs and staff ids unique, and every staff id from the demo', () => {
      expect(bySlug.size).toBe(166);
      expect(
        new Set(seed.menuItems.map((menuItem) => menuItem.legacyStaffId)).size,
      ).toBe(166);
      expect(
        seed.menuItems
          .filter((menuItem) => menuItem.department === 'RESTAURANT')
          .every((menuItem) => /^food-\d+$/.test(menuItem.legacyStaffId)),
      ).toBe(true);
      expect(
        seed.menuItems
          .filter((menuItem) => menuItem.department === 'BAR')
          .every((menuItem) => /^bar-\d+$/.test(menuItem.legacyStaffId)),
      ).toBe(true);
    });
  });

  describe('prices', () => {
    it('is whole kobo, never negative, for every item', () => {
      for (const menuItem of seed.menuItems) {
        expect(Number.isInteger(menuItem.priceKobo)).toBe(true);
        expect(menuItem.priceKobo).toBeGreaterThanOrEqual(0);
      }
    });

    it("seeds Q7's values: every slush at ₦2,500", () => {
      const slush = seed.menuItems.filter(
        (menuItem) => menuItem.menuCategorySlug === 'slush',
      );

      expect(slush).toHaveLength(14);
      expect(slush.every((menuItem) => menuItem.priceKobo === 250000)).toBe(
        true,
      );
    });

    it("seeds Q7's values: the grill", () => {
      expect(item('ribeye-steak').priceKobo).toBe(1050000);
      expect(item('lamb-chops').priceKobo).toBe(1050000);
      expect(item('balangu-style-ram-chops').priceKobo).toBe(1050000);
      expect(item('half-chicken').priceKobo).toBe(1550000);
      expect(item('whole-fish-croaker-or-catfish').priceKobo).toBe(1850000);
      expect(item('mixed-grill-platter').priceKobo).toBe(2250000);
      expect(item('sticky-bbq-pork-ribs').priceKobo).toBe(1250000);
      expect(item('honey-suya-pork-skewers').priceKobo).toBe(800000);
    });

    it("seeds Q7's values: sides ₦6,500 but Coconut Rice ₦1,500, sauces ₦3,500", () => {
      const sides = seed.menuItems.filter((menuItem) =>
        menuItem.slug.startsWith('side-'),
      );
      const sauces = seed.menuItems.filter((menuItem) =>
        menuItem.slug.startsWith('sauce-'),
      );

      expect(sides).toHaveLength(9);
      expect(sauces).toHaveLength(7);
      expect(item('side-coconut-rice').priceKobo).toBe(150000);
      expect(
        sides
          .filter((menuItem) => menuItem.slug !== 'side-coconut-rice')
          .every((menuItem) => menuItem.priceKobo === 650000),
      ).toBe(true);
      expect(sauces.every((menuItem) => menuItem.priceKobo === 350000)).toBe(
        true,
      );
    });
  });

  describe('which source wins', () => {
    it("takes the website's name where the staff name carries the variant", () => {
      expect(item('avocado-toast-tuna-or-eggs')).toMatchObject({
        legacyStaffId: 'food-6',
        name: 'Avocado Toast',
        choiceLabel: 'Topped with',
        choiceOptions: ['Poached eggs', 'Tuna'],
      });
      expect(item('whole-fish-croaker-or-catfish').name).toBe('Whole Fish');
      expect(item('wraps-beef-or-chicken').name).toBe('Wraps');
    });

    it("takes the website's description, blank for sides and sauces", () => {
      expect(item('side-french-fries').description).toBe('');
      expect(item('sauce-ranch').description).toBe('');
      expect(item('masa-and-suya').description).toBe(
        'Northern rice cakes griddled to order, topped with peppered suya beef and yaji, or sweet with Plateau honey',
      );
    });

    it('carries the staff category and the website group heading', () => {
      expect(item('firebird')).toMatchObject({
        staffCategoryName: 'Pizza',
        menuCategorySlug: 'street-and-social',
        groupLabel: 'Pizza',
        signature: true,
      });
      expect(item('karak-chai')).toMatchObject({
        staffCategoryName: 'Tea Corner (Hot)',
        menuCategorySlug: 'drinks',
        groupLabel: 'Tea Corner · Hot',
      });
      expect(item('slush-sunday-sunset').groupLabel).toBe('Sunday');
      expect(item('lamb-chops').groupLabel).toBeNull();
    });

    it('lists every item as available and shown online, in the website order', () => {
      expect(
        seed.menuItems.every(
          (menuItem) => menuItem.active && menuItem.showOnline,
        ),
      ).toBe(true);
      expect(item('masa-and-suya').sort).toBe(1);
      expect(item('oats-and-berries-with-nuts').sort).toBe(12);
      expect(item('tropical-cooler-jug').sort).toBe(73);
    });

    it('stores an empty category note as no note', () => {
      expect(
        seed.menuCategories.find((category) => category.slug === 'starters')
          ?.note,
      ).toBeNull();
      expect(
        seed.menuCategories.find((category) => category.slug === 'breakfast')
          ?.note,
      ).toBe('Served through the morning');
    });
  });

  describe('the paired Bar stock items', () => {
    it('pairs exactly one stock item with each of the 87 Bar items', () => {
      const barSlugs = seed.menuItems
        .filter((menuItem) => menuItem.department === 'BAR')
        .map((menuItem) => menuItem.slug)
        .sort();

      expect(seed.barStockItems).toHaveLength(87);
      expect(
        seed.barStockItems.map((stock) => stock.menuItemSlug).sort(),
      ).toEqual(barSlugs);
    });

    it('is named as its item, a serving from a batch of 12, reordered at 12', () => {
      for (const stock of seed.barStockItems) {
        expect(stock).toEqual({
          menuItemSlug: stock.menuItemSlug,
          name: item(stock.menuItemSlug).name,
          unit: 'serving',
          pack: 'batch',
          factor: 12,
          minimum: 12,
        });
      }
    });

    it('has names that are unique ignoring case, as the stock index requires', () => {
      expect(
        new Set(seed.barStockItems.map((stock) => stock.name.toLowerCase()))
          .size,
      ).toBe(87);
    });
  });

  describe('refusals', () => {
    it('refuses a price that differs between the sources', () => {
      const altered = sources();
      altered.staff[0].price += 100;

      expect(() => buildMenuSeed(altered)).toThrow(
        'The menu sources disagree: masa-and-suya costs 750000 kobo on the website and 750100 in the staff app.',
      );
    });

    it('refuses a price that is not whole kobo', () => {
      const altered = sources();
      altered.website[0].items[0].price = 7500.5;

      expect(() => buildMenuSeed(altered)).toThrow(/not whole kobo/);
    });

    it('refuses a choice that differs between the sources', () => {
      const altered = sources();
      altered.website[0].items[0].choice!.options.push('Plain');

      expect(() => buildMenuSeed(altered)).toThrow(/different choice/);
    });

    it('refuses a signature flag that differs between the sources', () => {
      const altered = sources();
      altered.staff[0].signature = true;

      expect(() => buildMenuSeed(altered)).toThrow(/signature dish in one/);
    });

    it('refuses a different name on a dish with no choice to carry it', () => {
      const altered = sources();
      altered.staff[1].name = "Jos Farmer's Big Breakfast";

      expect(() => buildMenuSeed(altered)).toThrow(/has no choice to carry/);
    });

    it('refuses a staff item missing from the id map', () => {
      const altered = sources();
      const dishes = altered.idMap.dishes as Record<string, string>;
      delete dishes['bar-87'];

      expect(() => buildMenuSeed(altered)).toThrow(
        'bar-87 is not in the id map.',
      );
    });

    it('refuses a website dish no staff item maps to', () => {
      const altered = sources();
      altered.website[0].items.push({
        id: 'new-dish',
        name: 'New Dish',
        price: 100000,
        desc: '',
      });

      expect(() => buildMenuSeed(altered)).toThrow(
        'the website dish new-dish has no staff item.',
      );
    });

    it('refuses two staff items mapped to one dish', () => {
      const altered = sources();
      const dishes = altered.idMap.dishes as Record<string, string>;
      dishes['food-2'] = 'masa-and-suya';

      expect(() => buildMenuSeed(altered)).toThrow(/two staff items map to/);
    });

    it('refuses a staff category placed in the wrong customer category', () => {
      const altered = sources();
      const categories = altered.idMap.categories as Record<string, string>;
      categories['Slush'] = 'drinks';

      expect(() => buildMenuSeed(altered)).toThrow(
        /is in Slush, but slush-mango-saffron-sunrise is in slush/,
      );
    });

    it('refuses a Bar category mapped to a food category', () => {
      const altered = sources();
      const categories = altered.idMap.categories as Record<string, string>;
      categories['Kids Drinks'] = 'for-the-little-ones';

      expect(() => buildMenuSeed(altered)).toThrow(
        'the staff category Kids Drinks is BAR but maps to the FOOD category for-the-little-ones.',
      );
    });
  });
});
