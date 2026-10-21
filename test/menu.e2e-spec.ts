import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  MenuCategoryKind,
  StaffRole,
} from '../generated/cnc-client';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { IDEMPOTENCY_KEY_REQUIRED } from '../src/idempotency/idempotency-key.decorator';
import {
  MENU_CATEGORY_MESSAGE,
  MENU_ITEM_NOT_FOUND_MESSAGE,
  MENU_NAME_PRICE_MESSAGE,
  STOCK_ITEM_EXISTS_MESSAGE,
} from '../src/menu/menu-messages';
import {
  OWNER_ONLY_NEW_MENU_ITEM_MESSAGE,
  OWNER_ONLY_PRICE_MESSAGE,
} from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { MediaStorage } from '../src/storage/media-storage';
import { createTestApp } from './create-test-app';
import { FakeMediaStorage } from './fake-media-storage';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';
import { testImage } from './test-images';

/**
 * Menu & Prices (C3-7) through HTTP and against Postgres: `menu.save`, the
 * Owner's price and new-item rules (the C3 gate's step 3), the paired Bar
 * stock item, Idempotency-Key on the create, and the photo routes.
 *
 * The suite makes its own categories and items, all run-unique, and never
 * edits a seeded item: the seed suite holds the seeded menu to its sources.
 */
describe('Menu & Prices (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let storage: FakeMediaStorage;

  let ownerToken: string;
  let managerToken: string;
  let cashierToken: string;

  let foodCategoryId: string;
  let drinksCategoryId: string;
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    storage = app.get<MediaStorage, FakeMediaStorage>(MediaStorage, {
      strict: false,
    });

    const tokens = app.get(CncTokenService, { strict: false });
    const token = async (role: StaffRole) =>
      accessTokenFor(
        tokens,
        (
          await createStaffAccount(prisma, role, {
            emailPrefix: 'menu',
            name: `Menu ${role.toLowerCase()}`,
          })
        ).id,
      );

    ownerToken = await token(StaffRole.OWNER);
    managerToken = await token(StaffRole.MANAGER);
    cashierToken = await token(StaffRole.CASHIER);

    const category = async (kind: MenuCategoryKind, department: Department) => {
      const menuCategory = await prisma.menuCategory.create({
        data: {
          slug: `test-${kind.toLowerCase()}-${tag}`,
          title: `Test ${kind} ${tag}`,
          kind,
          sort: 900,
        },
      });

      return (
        await prisma.staffCategory.create({
          data: {
            name: `Test ${department} ${tag}`,
            department,
            menuCategoryId: menuCategory.id,
          },
        })
      ).id;
    };

    foodCategoryId = await category(
      MenuCategoryKind.FOOD,
      Department.RESTAURANT,
    );
    drinksCategoryId = await category(MenuCategoryKind.DRINKS, Department.BAR);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  interface Item {
    id: string;
    slug: string;
    department: Department;
    staffCategoryId: string;
    staffCategoryName: string;
    menuCategorySlug: string;
    name: string;
    description: string;
    priceKobo: number;
    active: boolean;
    showOnline: boolean;
    photoUrl: string | null;
    photoAlt: string | null;
    choiceOptions: string[];
    sort: number;
    stockItemId: string | null;
    version: number;
  }

  const create = (
    token: string,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) =>
    request(server())
      .post('/api/v1/staff/menu')
      .set(auth(token))
      .set('Idempotency-Key', key)
      .send(body);

  const dish = (overrides: Record<string, unknown> = {}) => ({
    name: `Test Dish ${tag} ${randomUUID().slice(0, 4)}`,
    priceKobo: 350000,
    department: Department.RESTAURANT,
    staffCategoryId: foodCategoryId,
    ...overrides,
  });

  async function newDish(
    overrides: Record<string, unknown> = {},
  ): Promise<Item> {
    return (await create(ownerToken, dish(overrides)).expect(201)).body as Item;
  }

  const patch = (token: string, id: string, body: Record<string, unknown>) =>
    request(server())
      .patch(`/api/v1/staff/menu/${id}`)
      .set(auth(token))
      .send(body);

  describe('adding an item', () => {
    it('lets the Owner add a dish, with a slug from its name, last in its category', async () => {
      const first = await newDish({ name: `Pepper Soup ${tag}` });
      const second = await newDish({
        name: `Ofada Stew ${tag}`,
        description: '  Spicy  ',
        showOnline: false,
      });

      expect(first).toMatchObject({
        slug: `pepper-soup-${tag}`,
        department: Department.RESTAURANT,
        staffCategoryId: foodCategoryId,
        menuCategorySlug: `test-food-${tag}`,
        priceKobo: 350000,
        active: true,
        showOnline: true,
        photoUrl: null,
        choiceOptions: [],
        stockItemId: null,
        version: 0,
      });
      expect(second).toMatchObject({
        description: 'Spicy',
        showOnline: false,
        sort: first.sort + 1,
      });
    });

    it('never reuses a slug: the same name again is numbered', async () => {
      const name = `Moi Moi ${tag}`;
      const first = await newDish({ name });
      const second = await newDish({ name });

      expect(first.slug).toBe(`moi-moi-${tag}`);
      expect(second.slug).toBe(`moi-moi-${tag}-2`);
    });

    it('gives a new Bar item its paired Bar stock item in the same write', async () => {
      const name = `Zobo Spritz ${tag}`;
      const item = (
        await create(
          ownerToken,
          dish({
            name,
            department: Department.BAR,
            staffCategoryId: drinksCategoryId,
          }),
        ).expect(201)
      ).body as Item;

      const stock = await prisma.stockItem.findUniqueOrThrow({
        where: { menuItemId: item.id },
      });

      expect(item.stockItemId).toBe(stock.id);
      expect(stock).toMatchObject({
        name,
        kind: 'BAR',
        unit: 'serving',
        pack: 'batch',
        factor: 12,
        minimum: 12,
      });
    });

    it('refuses a Bar item whose stock name is taken, ignoring case, and adds nothing', async () => {
      const name = `Chapman Royale ${tag}`;
      await prisma.stockItem.create({
        data: {
          name: name.toUpperCase(),
          kind: 'KITCHEN',
          unit: 'portion',
          pack: 'tray',
          factor: 10,
          minimum: 0,
        },
      });
      const key = randomUUID();

      const response = await create(
        ownerToken,
        dish({
          name,
          department: Department.BAR,
          staffCategoryId: drinksCategoryId,
        }),
        key,
      ).expect(409);

      expect(messageOf(response)).toBe(STOCK_ITEM_EXISTS_MESSAGE);
      expect(await prisma.menuItem.count({ where: { name } })).toBe(0);
      expect(await prisma.idempotencyKey.count({ where: { key } })).toBe(0);
    });

    it('replays a retried create instead of adding a second item', async () => {
      const key = randomUUID();
      const body = dish({ name: `Asun ${tag}` });

      const first = await create(ownerToken, body, key).expect(201);
      const again = await create(ownerToken, body, key).expect(201);

      expect(again.body).toEqual(first.body);
      expect(
        await prisma.menuItem.count({ where: { name: `Asun ${tag}` } }),
      ).toBe(1);
    });

    it('needs an Idempotency-Key', async () => {
      const response = await request(server())
        .post('/api/v1/staff/menu')
        .set(auth(ownerToken))
        .send(dish())
        .expect(400);

      expect(messageOf(response)).toBe(IDEMPOTENCY_KEY_REQUIRED);
    });

    it('keeps adding an item for the Owner', async () => {
      const response = await create(managerToken, dish()).expect(403);
      expect(messageOf(response)).toBe(OWNER_ONLY_NEW_MENU_ITEM_MESSAGE);

      const cashier = await create(cashierToken, dish()).expect(403);
      expect(messageOf(cashier)).toBe(ROLE_REFUSED_MESSAGE);
    });

    it('answers a bad price, a missing name and a category of the other department', async () => {
      for (const body of [
        dish({ priceKobo: 0 }),
        dish({ priceKobo: 12.5 }),
        dish({ name: '  ' }),
      ]) {
        const response = await create(ownerToken, body).expect(400);
        expect(messageOf(response)).toContain(MENU_NAME_PRICE_MESSAGE);
      }

      const wrong = await create(
        ownerToken,
        dish({ department: Department.BAR }),
      ).expect(400);
      expect(messageOf(wrong)).toBe(MENU_CATEGORY_MESSAGE);
    });
  });

  describe('changing an item (gate step 3)', () => {
    it('refuses a manager’s price change and accepts their description change', async () => {
      const item = await newDish();

      const refused = await patch(managerToken, item.id, {
        version: item.version,
        priceKobo: item.priceKobo + 50000,
      }).expect(403);
      expect(messageOf(refused)).toBe(OWNER_ONLY_PRICE_MESSAGE);

      const saved = await patch(managerToken, item.id, {
        version: item.version,
        priceKobo: item.priceKobo,
        description: 'Slow-cooked',
        showOnline: false,
      }).expect(200);

      expect(saved.body as Item).toMatchObject({
        description: 'Slow-cooked',
        showOnline: false,
        priceKobo: item.priceKobo,
        version: item.version + 1,
      });
    });

    it('lets the Owner change a price, and records it in plain words', async () => {
      const item = await newDish({ priceKobo: 350000 });

      await patch(ownerToken, item.id, {
        version: item.version,
        priceKobo: 400000,
      }).expect(200);

      const history = await request(server())
        .get('/api/v1/staff/audit')
        .query({ ref: item.slug })
        .set(auth(ownerToken))
        .expect(200);
      const rows = (
        history.body as { data: { actionLabel: string; changes: string[] }[] }
      ).data;

      expect(rows[0]).toMatchObject({
        actionLabel: 'Menu Item Saved',
        changes: ['Price changed from ₦3,500 to ₦4,000.'],
      });
    });

    it('moves an item to another category of its department, never to the other', async () => {
      const item = await newDish();
      const other = await prisma.staffCategory.create({
        data: {
          name: `Test Other ${tag}`,
          department: Department.RESTAURANT,
          menuCategoryId: (
            await prisma.staffCategory.findUniqueOrThrow({
              where: { id: foodCategoryId },
            })
          ).menuCategoryId,
        },
      });

      const moved = await patch(managerToken, item.id, {
        version: item.version,
        staffCategoryId: other.id,
      }).expect(200);
      expect((moved.body as Item).staffCategoryName).toBe(`Test Other ${tag}`);

      const refused = await patch(managerToken, item.id, {
        version: (moved.body as Item).version,
        staffCategoryId: drinksCategoryId,
      }).expect(400);
      expect(messageOf(refused)).toBe(MENU_CATEGORY_MESSAGE);
    });

    it('answers a stale version with 409 and an unknown item with 404', async () => {
      const item = await newDish();

      await patch(managerToken, item.id, {
        version: item.version,
        active: false,
      }).expect(200);

      const stale = await patch(managerToken, item.id, {
        version: item.version,
        active: true,
      }).expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);

      const missing = await patch(managerToken, 'no-such-item', {
        version: 0,
        active: true,
      }).expect(404);
      expect(messageOf(missing)).toBe(MENU_ITEM_NOT_FOUND_MESSAGE);
    });

    it('does not take a department, a slug or a choice', async () => {
      const item = await newDish();

      for (const field of [
        { department: Department.BAR },
        { slug: 'renamed' },
        { choiceOptions: ['Beef'] },
      ]) {
        await patch(managerToken, item.id, {
          version: item.version,
          ...field,
        }).expect(400);
      }
    });
  });

  describe('photos', () => {
    const upload = (id: string, version: number, file: Buffer) =>
      request(server())
        .post(`/api/v1/staff/menu/${id}/photo`)
        .set(auth(managerToken))
        .field('version', String(version))
        .attach('photo', file, 'dish.png');

    it('fits a photo inside 800 pixels, replaces and removes it', async () => {
      const item = await newDish();

      const first = await upload(
        item.id,
        item.version,
        await testImage(2000, 1000, 'png'),
      ).expect(200);
      const firstUri = (
        await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } })
      ).photo!;
      const meta = await sharp(storage.objectAt(firstUri)?.body).metadata();

      expect([meta.width, meta.height, meta.format]).toEqual([800, 400, 'png']);
      expect((first.body as Item).photoUrl).toMatch(/\/menu\//);

      const second = await upload(
        item.id,
        (first.body as Item).version,
        await testImage(500, 500),
      ).expect(200);
      expect(storage.objectAt(firstUri)).toBeUndefined();

      const removed = await request(server())
        .delete(`/api/v1/staff/menu/${item.id}/photo`)
        .set(auth(managerToken))
        .send({ version: (second.body as Item).version })
        .expect(200);
      expect((removed.body as Item).photoUrl).toBeNull();

      const history = await prisma.auditLog.findMany({
        where: { ref: item.slug, action: 'menu.photo' },
      });
      expect(history).toHaveLength(3);
    });

    it('keeps photos for managers', async () => {
      const item = await newDish();

      const response = await request(server())
        .post(`/api/v1/staff/menu/${item.id}/photo`)
        .set(auth(cashierToken))
        .field('version', String(item.version))
        .attach('photo', await testImage(100, 100), 'dish.jpg')
        .expect(403);

      expect(messageOf(response)).toBe(ROLE_REFUSED_MESSAGE);
    });
  });

  describe('the list', () => {
    it('finds items by part of the name and department, for managers only', async () => {
      const item = await newDish({ name: `Findable Jollof ${tag}` });

      const response = await request(server())
        .get('/api/v1/staff/menu')
        .query({ q: `findable jollof ${tag}`, department: 'RESTAURANT' })
        .set(auth(managerToken))
        .expect(200);
      const page = response.body as { data: Item[]; total: number };

      expect(page.total).toBe(1);
      expect(page.data[0].id).toBe(item.id);

      const refused = await request(server())
        .get('/api/v1/staff/menu')
        .set(auth(cashierToken))
        .expect(403);
      expect(messageOf(refused)).toBe(ROLE_REFUSED_MESSAGE);
    });
  });
});
