import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  MenuCategoryKind,
  OrderStatus,
  StaffRole,
  StockKind,
  StockLocation,
  StockMovementType,
} from '../generated/cnc-client';
import { BUSINESS } from '../prisma/seed-data/reference';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { ADMIN_REASON_MESSAGE } from '../src/common/admin-reason';
import {
  LINES_DUPLICATE_MESSAGE,
  LINES_EMPTY_MESSAGE,
  LINES_QTY_MESSAGE,
} from '../src/common/command-lines';
import { watToday } from '../src/common/wat';
import { IDEMPOTENCY_KEY_REQUIRED } from '../src/idempotency/idempotency-key.decorator';
import {
  approvalLimitMessage,
  LIMITED_DECISIONS,
  ownerOnlyMessage,
  OWNER_ONLY_ACTIONS,
} from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { drawNumber } from '../src/prisma/sequences';
import {
  COUNT_ROLE_MESSAGE,
  COUNT_WHOLE_MESSAGE,
  insufficientStockMessage,
  ISSUE_ITEM_MESSAGE,
  ITEM_CONVERSION_MESSAGE,
  ITEM_NAME_UNITS_MESSAGE,
  LOCATION_ITEM_MESSAGE,
  MAPPING_FOOD_MESSAGE,
  MAPPING_PORTION_MESSAGE,
  STOCK_ITEM_EXISTS_MESSAGE,
  STOCK_ITEM_NOT_FOUND_MESSAGE,
  WHOLE_ABOVE_ZERO_MESSAGE,
} from '../src/stock/stock-messages';
import { createTestApp } from './create-test-app';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * The stock core (C4-2) through HTTP and against Postgres: stock items and
 * their units, the stock count (with Q28's limit), the direct issue, the
 * Owner's Correct Balance, the balance and movement reads, the ledger's
 * running sum, and the kitchen comparison rules. The demo's
 * `stock.test.cjs` cases are ported here, by name.
 *
 * Every item, dish and account is run-unique and never removed; the suite
 * never touches a seeded stock item.
 */
describe('Stock core (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  const token: Partial<Record<StaffRole, string>> = {};
  const staffId: Partial<Record<StaffRole, string>> = {};
  const tag = randomUUID().slice(0, 8);

  /** A run-unique Restaurant dish, and a Bar drink with its paired stock item. */
  let dishId: string;
  let dishSlug: string;
  let barMenuItemId: string;
  let barStockId: string;
  let barDrinkPriceKobo: number;
  let approvalLimitKobo: number;
  let drinksCategory: { menuCategoryId: string; staffCategoryId: string };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);

    // The settings row the limits are read from, with the column defaults,
    // and the business row the staff reference read needs, if no seed has
    // run on this database (a fresh CI database); never changed if present.
    await prisma.settings.createMany({ data: [{}], skipDuplicates: true });
    await prisma.business.createMany({
      data: [{ ...BUSINESS, addressLines: [...BUSINESS.addressLines] }],
      skipDuplicates: true,
    });
    approvalLimitKobo = (
      await prisma.settings.findUniqueOrThrow({
        where: { singleton: true },
        select: { approvalLimitKobo: true },
      })
    ).approvalLimitKobo;

    const tokens = app.get(CncTokenService, { strict: false });

    for (const role of [
      StaffRole.OWNER,
      StaffRole.MANAGER,
      StaffRole.STOREKEEPER,
      StaffRole.KITCHEN,
      StaffRole.BARTENDER,
      StaffRole.WAITER,
    ]) {
      const account = await createStaffAccount(prisma, role, {
        emailPrefix: 'stock',
        name: `Stock ${role.toLowerCase()} ${tag}`,
      });
      staffId[role] = account.id;
      token[role] = await accessTokenFor(tokens, account.id);
    }

    const category = async (kind: MenuCategoryKind, department: Department) => {
      const menuCategory = await prisma.menuCategory.create({
        data: {
          slug: `stock-${kind.toLowerCase()}-${tag}`,
          title: `Stock ${kind} ${tag}`,
          kind,
          sort: 900,
        },
      });
      const staffCategory = await prisma.staffCategory.create({
        data: {
          name: `Stock ${department} ${tag}`,
          department,
          menuCategoryId: menuCategory.id,
        },
      });

      return {
        menuCategoryId: menuCategory.id,
        staffCategoryId: staffCategory.id,
      };
    };

    const food = await category(MenuCategoryKind.FOOD, Department.RESTAURANT);
    const dish = await prisma.menuItem.create({
      data: {
        slug: `stock-dish-${tag}`,
        department: Department.RESTAURANT,
        ...food,
        name: `Stock Dish ${tag}`,
        priceKobo: 500000,
      },
    });
    dishId = dish.id;
    dishSlug = dish.slug;

    // A drink dear enough that one batch at the Store is worth more than
    // the Owner Approval Limit (Q28: valued at menu price × quantity).
    barDrinkPriceKobo = approvalLimitKobo + 100;
    drinksCategory = await category(MenuCategoryKind.DRINKS, Department.BAR);
    const drink = await prisma.menuItem.create({
      data: {
        slug: `stock-drink-${tag}`,
        department: Department.BAR,
        ...drinksCategory,
        name: `Stock Drink ${tag}`,
        priceKobo: barDrinkPriceKobo,
      },
    });
    barMenuItemId = drink.id;
    barStockId = (
      await prisma.stockItem.create({
        data: {
          name: `Stock Drink ${tag}`,
          kind: StockKind.BAR,
          unit: 'serving',
          pack: 'batch',
          factor: 12,
          minimum: 12,
          menuItemId: drink.id,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const auth = (role: StaffRole) => ({
    Authorization: `Bearer ${token[role]}`,
  });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  interface Item {
    id: string;
    name: string;
    kind: StockKind;
    unit: string;
    pack: string;
    factor: number;
    minimum: number;
    version: number;
  }

  interface Balance {
    stockItemId: string;
    qty: number;
    low: boolean;
    pendingQty: number | null;
  }

  /** A new run-unique Kitchen item, made through the route by a manager. */
  async function kitchenItem(
    fields: Partial<Record<'factor' | 'minimum', number>> = {},
  ): Promise<Item> {
    const response = await request(server())
      .post('/api/v1/staff/stock/items')
      .set(auth(StaffRole.MANAGER))
      .send({
        name: `Portion ${randomUUID()}`,
        unit: 'portion',
        pack: 'tray',
        factor: fields.factor ?? 10,
        minimum: fields.minimum ?? 15,
      })
      .expect(201);

    return response.body as Item;
  }

  /** One item's balance at one location, read through the route. */
  async function balanceOf(
    stockItemId: string,
    location: StockLocation,
    role: StaffRole = StaffRole.STOREKEEPER,
  ): Promise<Balance> {
    const name = (
      await prisma.stockItem.findUniqueOrThrow({
        where: { id: stockItemId },
        select: { name: true },
      })
    ).name;
    const response = await request(server())
      .get('/api/v1/staff/stock/balances')
      .query({ location, q: name })
      .set(auth(role))
      .expect(200);
    const row = (response.body as { data: Balance[] }).data.find(
      (b) => b.stockItemId === stockItemId,
    );

    if (row === undefined) throw new Error(`No balance row for ${name}.`);

    return row;
  }

  const count = (
    role: StaffRole,
    location: StockLocation,
    counts: unknown,
    reason?: string,
    key: string = randomUUID(),
  ) =>
    request(server())
      .post('/api/v1/staff/stock/counts')
      .set(auth(role))
      .set('Idempotency-Key', key)
      .send({ location, counts, ...(reason ? { reason } : {}) });

  const issue = (
    role: StaffRole,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) =>
    request(server())
      .post('/api/v1/staff/stock/issues')
      .set(auth(role))
      .set('Idempotency-Key', key)
      .send(body);

  const adjust = (role: StaffRole, body: Record<string, unknown>) =>
    request(server())
      .post('/api/v1/staff/stock/adjustments')
      .set(auth(role))
      .set('Idempotency-Key', randomUUID())
      .send(body);

  /** The Owner records an opening balance by stock count (the C4 gate, step 1). */
  async function opening(
    stockItemId: string,
    location: StockLocation,
    counted: number,
  ): Promise<void> {
    await count(StaffRole.OWNER, location, [{ stockItemId, counted }]).expect(
      201,
    );
  }

  /** The balance must equal the sum of the item's movements there. */
  async function expectLedgerHolds(
    stockItemId: string,
    location: StockLocation,
  ): Promise<void> {
    const sum = await prisma.stockMovement.aggregate({
      where: { stockItemId, location },
      _sum: { qty: true },
    });
    const balance = await prisma.stockBalance.findUnique({
      where: { stockItemId_location: { stockItemId, location } },
      select: { qty: true },
    });

    expect(balance?.qty ?? 0).toBe(sum._sum.qty ?? 0);
  }

  describe('stock items (stockitem.create, stockitem.save)', () => {
    it('lets a manager add a Kitchen item, which starts at zero', async () => {
      const item = await kitchenItem();

      expect(item).toMatchObject({
        kind: StockKind.KITCHEN,
        unit: 'portion',
        pack: 'tray',
        factor: 10,
        minimum: 15,
        version: 0,
      });
      expect((await balanceOf(item.id, StockLocation.STORE)).qty).toBe(0);
      expect((await balanceOf(item.id, StockLocation.KITCHEN)).qty).toBe(0);

      const entry = await prisma.auditLog.findFirst({
        where: { action: 'stockitem.create', ref: item.id },
      });
      expect(entry?.module).toBe('Stock & Requests');
    });

    it('refuses a name another item holds, ignoring case', async () => {
      const item = await kitchenItem();

      const response = await request(server())
        .post('/api/v1/staff/stock/items')
        .set(auth(StaffRole.MANAGER))
        .send({
          name: item.name.toUpperCase(),
          unit: 'portion',
          pack: 'tray',
          factor: 10,
          minimum: 0,
        })
        .expect(409);

      expect(messageOf(response)).toBe(STOCK_ITEM_EXISTS_MESSAGE);
    });

    it('refuses blank units and a conversion that is not whole', async () => {
      const blank = await request(server())
        .post('/api/v1/staff/stock/items')
        .set(auth(StaffRole.MANAGER))
        .send({
          name: `X ${tag}`,
          unit: ' ',
          pack: 'tray',
          factor: 1,
          minimum: 0,
        })
        .expect(400);
      expect(messageOf(blank)).toEqual([ITEM_NAME_UNITS_MESSAGE]);

      const half = await request(server())
        .post('/api/v1/staff/stock/items')
        .set(auth(StaffRole.MANAGER))
        .send({
          name: `Y ${tag}`,
          unit: 'u',
          pack: 'p',
          factor: 1.5,
          minimum: 0,
        })
        .expect(400);
      expect(messageOf(half)).toEqual([ITEM_CONVERSION_MESSAGE]);
    });

    it('is managers only', async () => {
      const response = await request(server())
        .post('/api/v1/staff/stock/items')
        .set(auth(StaffRole.STOREKEEPER))
        .send({ name: `Z ${tag}`, unit: 'u', pack: 'p', factor: 1, minimum: 0 })
        .expect(403);

      expect(messageOf(response)).toBe(ROLE_REFUSED_MESSAGE);
    });

    it('changes units with a reason and keeps the Store’s packs (D40)', async () => {
      const item = await kitchenItem();
      await opening(item.id, StockLocation.STORE, 4);

      const response = await request(server())
        .patch(`/api/v1/staff/stock/items/${item.id}`)
        .set(auth(StaffRole.MANAGER))
        .send({
          unit: 'bowl',
          pack: 'crate',
          factor: 24,
          minimum: 12,
          reason: 'Convert packs to crates',
          version: item.version,
        })
        .expect(200);

      expect(response.body).toMatchObject({
        unit: 'bowl',
        pack: 'crate',
        factor: 24,
        minimum: 12,
        version: item.version + 1,
      });
      expect((await balanceOf(item.id, StockLocation.STORE)).qty).toBe(4);

      const entry = await prisma.auditLog.findFirst({
        where: { action: 'stockitem.save', ref: item.id },
      });
      expect(entry?.reason).toBe('Convert packs to crates');
      expect(entry?.before).toMatchObject({ factor: 10 });
    });

    it('needs a reason, the current version and an item that exists', async () => {
      const item = await kitchenItem();
      const body = {
        unit: 'portion',
        pack: 'tray',
        factor: 10,
        minimum: 5,
        version: item.version,
      };

      const noReason = await request(server())
        .patch(`/api/v1/staff/stock/items/${item.id}`)
        .set(auth(StaffRole.MANAGER))
        .send(body)
        .expect(400);
      expect(messageOf(noReason)).toEqual([ADMIN_REASON_MESSAGE]);

      await request(server())
        .patch(`/api/v1/staff/stock/items/${item.id}`)
        .set(auth(StaffRole.MANAGER))
        .send({ ...body, reason: 'First' })
        .expect(200);

      const stale = await request(server())
        .patch(`/api/v1/staff/stock/items/${item.id}`)
        .set(auth(StaffRole.MANAGER))
        .send({ ...body, reason: 'Second' })
        .expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);

      const missing = await request(server())
        .patch(`/api/v1/staff/stock/items/missing-${tag}`)
        .set(auth(StaffRole.MANAGER))
        .send({ ...body, reason: 'Third' })
        .expect(404);
      expect(messageOf(missing)).toBe(STOCK_ITEM_NOT_FOUND_MESSAGE);
    });
  });

  describe('stock count (stock.count)', () => {
    it('stock count records only the differences, in whole numbers', async () => {
      const a = await kitchenItem();
      const b = await kitchenItem();
      await opening(a.id, StockLocation.STORE, 8);
      await opening(b.id, StockLocation.STORE, 8);
      const before = await prisma.stockMovement.count({
        where: { stockItemId: { in: [a.id, b.id] } },
      });

      const response = await count(StaffRole.STOREKEEPER, StockLocation.STORE, [
        { stockItemId: a.id, counted: 5 },
        { stockItemId: b.id, counted: 8 },
      ]).expect(201);

      expect(response.body).toEqual({
        location: StockLocation.STORE,
        changes: [
          {
            stockItemId: a.id,
            name: a.name,
            recorded: 8,
            counted: 5,
            difference: -3,
          },
        ],
      });
      expect((await balanceOf(a.id, StockLocation.STORE)).qty).toBe(5);
      expect(
        await prisma.stockMovement.count({
          where: { stockItemId: { in: [a.id, b.id] } },
        }),
      ).toBe(before + 1);

      const movement = await prisma.stockMovement.findFirstOrThrow({
        where: { stockItemId: a.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(movement).toMatchObject({
        type: StockMovementType.STOCK_COUNT,
        qty: -3,
        ref: 'Stock count',
        staffId: staffId.STOREKEEPER,
      });

      const half = await count(StaffRole.STOREKEEPER, StockLocation.STORE, [
        { stockItemId: a.id, counted: 2.5 },
      ]).expect(400);
      expect(messageOf(half)).toEqual([COUNT_WHOLE_MESSAGE]);

      await expectLedgerHolds(a.id, StockLocation.STORE);
    });

    it('lets only the storekeeper count the Store, and managers any location', async () => {
      const item = await kitchenItem();
      const counts = [{ stockItemId: item.id, counted: 1 }];

      for (const [role, location] of [
        [StaffRole.STOREKEEPER, StockLocation.KITCHEN],
        [StaffRole.KITCHEN, StockLocation.KITCHEN],
        [StaffRole.WAITER, StockLocation.STORE],
      ] as const) {
        const refused = await count(role, location, counts).expect(403);
        expect(messageOf(refused)).toBe(COUNT_ROLE_MESSAGE);
      }

      await count(StaffRole.MANAGER, StockLocation.KITCHEN, counts).expect(201);
      expect((await balanceOf(item.id, StockLocation.KITCHEN)).qty).toBe(1);
    });

    it('refuses an item twice, an item the location does not hold and an unknown item', async () => {
      const item = await kitchenItem();

      const twice = await count(StaffRole.MANAGER, StockLocation.STORE, [
        { stockItemId: item.id, counted: 1 },
        { stockItemId: item.id, counted: 2 },
      ]).expect(400);
      expect(messageOf(twice)).toEqual([LINES_DUPLICATE_MESSAGE]);

      const wrongPlace = await count(StaffRole.MANAGER, StockLocation.BAR, [
        { stockItemId: item.id, counted: 1 },
      ]).expect(400);
      expect(messageOf(wrongPlace)).toBe(LOCATION_ITEM_MESSAGE);

      const unknown = await count(StaffRole.MANAGER, StockLocation.STORE, [
        { stockItemId: `missing-${tag}`, counted: 1 },
      ]).expect(404);
      expect(messageOf(unknown)).toBe(STOCK_ITEM_NOT_FOUND_MESSAGE);
    });

    it('needs the Owner for a difference above the Owner Approval Limit (Q28), and counts it toward the day', async () => {
      // One batch of the drink is worth more than the limit.
      const refused = await count(StaffRole.STOREKEEPER, StockLocation.STORE, [
        { stockItemId: barStockId, counted: 1 },
      ]).expect(403);
      expect(messageOf(refused)).toBe(
        approvalLimitMessage(LIMITED_DECISIONS.stockCount, approvalLimitKobo),
      );
      expect((await balanceOf(barStockId, StockLocation.STORE)).qty).toBe(0);

      await opening(barStockId, StockLocation.STORE, 1);
      expect((await balanceOf(barStockId, StockLocation.STORE)).qty).toBe(1);

      // A count of a cheap item by the Storekeeper is recorded in the
      // Daily Approval Limit's ledger, at its value (zero for a Kitchen
      // item with no purchase cost yet, so it writes no row).
      const portion = await kitchenItem();
      await count(StaffRole.STOREKEEPER, StockLocation.STORE, [
        { stockItemId: portion.id, counted: 3 },
      ]).expect(201);
      expect(
        await prisma.approvalLedger.count({
          where: { staffId: staffId.STOREKEEPER, action: 'stock.count' },
        }),
      ).toBe(0);
    });

    it('records a manager’s valued count in the daily ledger', async () => {
      // A cheap drink of its own: two servings at ₦1,500 are within the limit.
      const cheap = await prisma.menuItem.create({
        data: {
          slug: `stock-cheap-${tag}`,
          department: Department.BAR,
          ...drinksCategory,
          name: `Stock Cheap ${tag}`,
          priceKobo: 150000,
        },
      });
      const cheapStock = await prisma.stockItem.create({
        data: {
          name: `Stock Cheap ${tag}`,
          kind: StockKind.BAR,
          unit: 'serving',
          pack: 'batch',
          factor: 12,
          minimum: 12,
          menuItemId: cheap.id,
        },
      });
      const before = await prisma.approvalLedger.count({
        where: { staffId: staffId.MANAGER, action: 'stock.count' },
      });

      await count(StaffRole.MANAGER, StockLocation.BAR, [
        { stockItemId: cheapStock.id, counted: 2 },
      ]).expect(201);

      const rows = await prisma.approvalLedger.findMany({
        where: { staffId: staffId.MANAGER, action: 'stock.count' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(rows).toHaveLength(before + 1);
      expect(rows[0]).toMatchObject({
        amountKobo: 300000,
        ref: StockLocation.BAR,
        businessDate: watToday(new Date()),
      });
    });

    /** A run-unique drink and its paired Bar stock item of 12 servings a batch. */
    async function pairedDrink(label: string, priceKobo: number) {
      const drink = await prisma.menuItem.create({
        data: {
          slug: `stock-${label}-${tag}`,
          department: Department.BAR,
          ...drinksCategory,
          name: `Stock ${label} ${tag}`,
          priceKobo,
        },
      });

      return prisma.stockItem.create({
        data: {
          name: `Stock ${label} ${tag}`,
          kind: StockKind.BAR,
          unit: 'serving',
          pack: 'batch',
          factor: 12,
          minimum: 12,
          menuItemId: drink.id,
        },
      });
    }

    it('values a Store count of Bar batches as servings: packs × How Many in One × price (Q28)', async () => {
      // One batch is worth six times the limit; one serving half of it.
      const dear = await pairedDrink(
        'half-limit',
        Math.floor(approvalLimitKobo / 2),
      );

      const refused = await count(StaffRole.STOREKEEPER, StockLocation.STORE, [
        { stockItemId: dear.id, counted: 1 },
      ]).expect(403);
      expect(messageOf(refused)).toBe(
        approvalLimitMessage(LIMITED_DECISIONS.stockCount, approvalLimitKobo),
      );
      expect((await balanceOf(dear.id, StockLocation.STORE)).qty).toBe(0);

      // Within the limit, the day's ledger holds the servings' value.
      const cheap = await pairedDrink('store-cheap', 10000);
      await count(StaffRole.STOREKEEPER, StockLocation.STORE, [
        { stockItemId: cheap.id, counted: 2 },
      ]).expect(201);

      const row = await prisma.approvalLedger.findFirstOrThrow({
        where: { staffId: staffId.STOREKEEPER, action: 'stock.count' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(row).toMatchObject({
        amountKobo: 2 * 12 * 10000,
        ref: StockLocation.STORE,
      });
    });

    it('needs an Idempotency-Key, and a retry replays the first count instead of undoing later moves', async () => {
      const item = await kitchenItem({ factor: 10 });
      await opening(item.id, StockLocation.KITCHEN, 12);
      await opening(item.id, StockLocation.STORE, 1);
      const counts = [{ stockItemId: item.id, counted: 10 }];

      const missing = await request(server())
        .post('/api/v1/staff/stock/counts')
        .set(auth(StaffRole.MANAGER))
        .send({ location: StockLocation.KITCHEN, counts })
        .expect(400);
      expect(messageOf(missing)).toBe(IDEMPOTENCY_KEY_REQUIRED);

      const key = randomUUID();
      const first = await count(
        StaffRole.MANAGER,
        StockLocation.KITCHEN,
        counts,
        undefined,
        key,
      ).expect(201);
      expect((await balanceOf(item.id, StockLocation.KITCHEN)).qty).toBe(10);

      // A pack reaches the Kitchen before the lost response is retried.
      await issue(StaffRole.STOREKEEPER, {
        location: StockLocation.KITCHEN,
        stockItemId: item.id,
        qty: 1,
      }).expect(201);

      const replay = await count(
        StaffRole.MANAGER,
        StockLocation.KITCHEN,
        counts,
        undefined,
        key,
      ).expect(201);

      expect(replay.body).toEqual(first.body);
      expect((await balanceOf(item.id, StockLocation.KITCHEN)).qty).toBe(20);
      await expectLedgerHolds(item.id, StockLocation.KITCHEN);
    });
  });

  describe('direct issue (stock.issue)', () => {
    it('the storekeeper can issue directly in whole packs, received as units', async () => {
      const item = await kitchenItem({ factor: 10 });
      await opening(item.id, StockLocation.STORE, 5);
      const kitchenBefore = (await balanceOf(item.id, StockLocation.KITCHEN))
        .qty;

      const response = await issue(StaffRole.STOREKEEPER, {
        location: StockLocation.KITCHEN,
        stockItemId: item.id,
        qty: 2,
        note: 'Evening rush',
      }).expect(201);

      expect(response.body).toEqual({
        stockItemId: item.id,
        location: StockLocation.KITCHEN,
        packs: 2,
        units: 20,
        storeQty: 3,
        destinationQty: kitchenBefore + 20,
      });

      const moves = await prisma.stockMovement.findMany({
        where: { stockItemId: item.id, ref: 'Evening rush' },
        orderBy: { location: 'asc' },
        select: { location: true, qty: true, type: true },
      });
      expect(moves).toEqual(
        expect.arrayContaining([
          {
            location: StockLocation.STORE,
            qty: -2,
            type: StockMovementType.ISSUE_TO_KITCHEN,
          },
          {
            location: StockLocation.KITCHEN,
            qty: 20,
            type: StockMovementType.STOCK_RECEIVED,
          },
        ]),
      );
      await expectLedgerHolds(item.id, StockLocation.STORE);
      await expectLedgerHolds(item.id, StockLocation.KITCHEN);
    });

    it('issues a Bar item to the Bar only, and only the storekeeper and managers may issue', async () => {
      const kitchen = await issue(StaffRole.KITCHEN, {
        location: StockLocation.KITCHEN,
        stockItemId: barStockId,
        qty: 1,
      }).expect(403);
      expect(messageOf(kitchen)).toBe(ROLE_REFUSED_MESSAGE);

      const wrongPlace = await issue(StaffRole.STOREKEEPER, {
        location: StockLocation.KITCHEN,
        stockItemId: barStockId,
        qty: 1,
      }).expect(400);
      expect(messageOf(wrongPlace)).toBe(ISSUE_ITEM_MESSAGE);

      const store = await issue(StaffRole.STOREKEEPER, {
        location: StockLocation.STORE,
        stockItemId: barStockId,
        qty: 1,
      }).expect(400);
      expect(messageOf(store)).toEqual(['Choose Kitchen or Bar.']);

      const half = await issue(StaffRole.STOREKEEPER, {
        location: StockLocation.BAR,
        stockItemId: barStockId,
        qty: 1.5,
      }).expect(400);
      expect(messageOf(half)).toEqual([WHOLE_ABOVE_ZERO_MESSAGE]);
    });

    it('refuses more packs than the Store holds and changes nothing', async () => {
      const item = await kitchenItem();
      await opening(item.id, StockLocation.STORE, 1);

      const response = await issue(StaffRole.STOREKEEPER, {
        location: StockLocation.KITCHEN,
        stockItemId: item.id,
        qty: 2,
      }).expect(409);

      expect(messageOf(response)).toBe(
        insufficientStockMessage(StockLocation.STORE, item.name),
      );
      expect(messageOf(response)).toBe(
        `Insufficient store stock for ${item.name}.`,
      );
      expect((await balanceOf(item.id, StockLocation.STORE)).qty).toBe(1);
      expect((await balanceOf(item.id, StockLocation.KITCHEN)).qty).toBe(0);
    });

    it('lets two issues race for the last pack and only one win', async () => {
      const item = await kitchenItem();
      await opening(item.id, StockLocation.STORE, 1);

      const [first, second] = await Promise.all(
        [0, 1].map(() =>
          issue(StaffRole.STOREKEEPER, {
            location: StockLocation.KITCHEN,
            stockItemId: item.id,
            qty: 1,
          }),
        ),
      );

      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expect((await balanceOf(item.id, StockLocation.STORE)).qty).toBe(0);
      expect((await balanceOf(item.id, StockLocation.KITCHEN)).qty).toBe(10);
      await expectLedgerHolds(item.id, StockLocation.STORE);
    });

    it('needs an Idempotency-Key, and a retry with the same key issues once', async () => {
      const item = await kitchenItem();
      await opening(item.id, StockLocation.STORE, 3);
      const body = {
        location: StockLocation.KITCHEN,
        stockItemId: item.id,
        qty: 1,
      };

      const missing = await request(server())
        .post('/api/v1/staff/stock/issues')
        .set(auth(StaffRole.STOREKEEPER))
        .send(body)
        .expect(400);
      expect(messageOf(missing)).toBe(IDEMPOTENCY_KEY_REQUIRED);

      const key = randomUUID();
      const first = await issue(StaffRole.STOREKEEPER, body, key).expect(201);
      const replay = await issue(StaffRole.STOREKEEPER, body, key).expect(201);

      expect(replay.body).toEqual(first.body);
      expect((await balanceOf(item.id, StockLocation.STORE)).qty).toBe(2);
    });
  });

  describe('Correct Balance (stock.adjust)', () => {
    it('correct balance takes Add or Remove, a whole number and a reason', async () => {
      const item = await kitchenItem();
      await opening(item.id, StockLocation.KITCHEN, 10);

      const removed = await adjust(StaffRole.OWNER, {
        location: StockLocation.KITCHEN,
        stockItemId: item.id,
        direction: 'REMOVE',
        qty: 4,
        reason: 'Miscount',
      }).expect(201);
      expect(removed.body).toEqual({
        stockItemId: item.id,
        location: StockLocation.KITCHEN,
        qty: -4,
        balance: 6,
      });

      await adjust(StaffRole.OWNER, {
        location: StockLocation.KITCHEN,
        stockItemId: item.id,
        direction: 'ADD',
        qty: 1,
        reason: 'Found tray',
      }).expect(201);
      expect((await balanceOf(item.id, StockLocation.KITCHEN)).qty).toBe(7);

      const half = await adjust(StaffRole.OWNER, {
        location: StockLocation.KITCHEN,
        stockItemId: item.id,
        direction: 'ADD',
        qty: 0.5,
        reason: 'x',
      }).expect(400);
      expect(messageOf(half)).toEqual([WHOLE_ABOVE_ZERO_MESSAGE]);

      const blank = await adjust(StaffRole.OWNER, {
        location: StockLocation.KITCHEN,
        stockItemId: item.id,
        direction: 'ADD',
        qty: 1,
        reason: '',
      }).expect(400);
      expect(messageOf(blank)).toEqual([ADMIN_REASON_MESSAGE]);

      const movement = await prisma.stockMovement.findFirstOrThrow({
        where: { stockItemId: item.id, ref: 'Miscount' },
      });
      expect(movement).toMatchObject({
        type: StockMovementType.ADMIN_ADJUSTMENT,
        qty: -4,
        staffId: staffId.OWNER,
      });
      await expectLedgerHolds(item.id, StockLocation.KITCHEN);
    });

    it('only the Owner corrects a stock balance', async () => {
      const item = await kitchenItem();
      await opening(item.id, StockLocation.KITCHEN, 5);
      const body = {
        location: StockLocation.KITCHEN,
        stockItemId: item.id,
        direction: 'REMOVE',
        qty: 1,
        reason: 'Miscount',
      };

      for (const role of [StaffRole.MANAGER, StaffRole.WAITER]) {
        const refused = await adjust(role, body).expect(403);
        expect(messageOf(refused)).toBe(
          ownerOnlyMessage(OWNER_ONLY_ACTIONS.correctStockBalance),
        );
        expect(messageOf(refused)).toBe(
          'Only the Owner can correct a stock balance.',
        );
      }

      expect((await balanceOf(item.id, StockLocation.KITCHEN)).qty).toBe(5);
      await adjust(StaffRole.OWNER, body).expect(201);
      expect((await balanceOf(item.id, StockLocation.KITCHEN)).qty).toBe(4);
    });

    it('refuses a removal below zero and an item the location does not hold', async () => {
      const item = await kitchenItem();

      const below = await adjust(StaffRole.OWNER, {
        location: StockLocation.KITCHEN,
        stockItemId: item.id,
        direction: 'REMOVE',
        qty: 1,
        reason: 'Test',
      }).expect(409);
      expect(messageOf(below)).toBe(
        `Insufficient kitchen stock for ${item.name}.`,
      );

      const wrongPlace = await adjust(StaffRole.OWNER, {
        location: StockLocation.BAR,
        stockItemId: item.id,
        direction: 'ADD',
        qty: 1,
        reason: 'Test',
      }).expect(400);
      expect(messageOf(wrongPlace)).toBe(LOCATION_ITEM_MESSAGE);
    });
  });

  describe('reads', () => {
    it('shows each role its own location only, with Low Stock and the drinks on unsettled bills', async () => {
      const item = await kitchenItem({ minimum: 15 });
      await opening(item.id, StockLocation.KITCHEN, 14);

      const kitchen = await balanceOf(
        item.id,
        StockLocation.KITCHEN,
        StaffRole.KITCHEN,
      );
      expect(kitchen).toMatchObject({ qty: 14, low: true, pendingQty: null });

      const elsewhere = await request(server())
        .get('/api/v1/staff/stock/balances')
        .query({ location: StockLocation.BAR })
        .set(auth(StaffRole.KITCHEN))
        .expect(403);
      expect(messageOf(elsewhere)).toBe(ROLE_REFUSED_MESSAGE);

      await request(server())
        .get('/api/v1/staff/stock/balances')
        .query({ location: StockLocation.STORE })
        .set(auth(StaffRole.BARTENDER))
        .expect(403);
      await request(server())
        .get('/api/v1/staff/stock/balances')
        .query({ location: StockLocation.BAR })
        .set(auth(StaffRole.WAITER))
        .expect(403);

      // Three drinks on an Open Bar bill are pending, not yet deducted.
      const order = await prisma.order.create({
        data: {
          number: await drawNumber(prisma, 'orderBar'),
          department: Department.BAR,
          label: 'Stock test',
          businessDate: watToday(new Date()),
          status: OrderStatus.OPEN,
          vatBps: 750,
          serviceBps: 0,
        },
      });
      await prisma.orderLine.create({
        data: {
          orderId: order.id,
          menuItemId: barMenuItemId,
          name: 'Stock Drink',
          qty: 3,
          unitPriceKobo: barDrinkPriceKobo,
          department: Department.BAR,
        },
      });

      const bar = await balanceOf(
        barStockId,
        StockLocation.BAR,
        StaffRole.BARTENDER,
      );
      expect(bar.pendingQty).toBe(3);
    });

    it('requires a location', async () => {
      const response = await request(server())
        .get('/api/v1/staff/stock/balances')
        .set(auth(StaffRole.STOREKEEPER))
        .expect(400);

      expect(messageOf(response)).toEqual(['Choose a stock location.']);
    });

    it('shows movements, newest first, to the storekeeper and managers only', async () => {
      const item = await kitchenItem();
      await opening(item.id, StockLocation.STORE, 2);
      await issue(StaffRole.STOREKEEPER, {
        location: StockLocation.KITCHEN,
        stockItemId: item.id,
        qty: 1,
      }).expect(201);

      const response = await request(server())
        .get('/api/v1/staff/stock/movements')
        .query({ stockItemId: item.id, location: StockLocation.STORE })
        .set(auth(StaffRole.STOREKEEPER))
        .expect(200);
      const body = response.body as {
        data: { qty: number; type: string; staffName: string | null }[];
        total: number;
      };

      expect(body.total).toBe(2);
      expect(body.data.map((m) => [m.qty, m.type])).toEqual([
        [-1, StockMovementType.ISSUE_TO_KITCHEN],
        [2, StockMovementType.STOCK_COUNT],
      ]);
      expect(body.data[0].staffName).toBe(`Stock storekeeper ${tag}`);

      const kitchen = await request(server())
        .get('/api/v1/staff/stock/movements')
        .set(auth(StaffRole.KITCHEN))
        .expect(403);
      expect(messageOf(kitchen)).toBe(ROLE_REFUSED_MESSAGE);
    });
  });

  describe('kitchen comparison rules (mapping.save)', () => {
    const save = (role: StaffRole, menuItemId: string, lines: unknown) =>
      request(server())
        .put(`/api/v1/staff/kitchen-mappings/${menuItemId}`)
        .set(auth(role))
        .send({ lines });

    it('adds and then replaces a dish’s rule, and lists it', async () => {
      const rice = await kitchenItem();
      const chicken = await kitchenItem();

      const first = await save(StaffRole.MANAGER, dishId, [
        { stockItemId: rice.id, qty: 1 },
        { stockItemId: chicken.id, qty: 1 },
      ]).expect(200);
      expect(first.body).toEqual({
        menuItemId: dishId,
        menuItemSlug: dishSlug,
        menuItemName: `Stock Dish ${tag}`,
        lines: [
          { stockItemId: rice.id, stockItemName: rice.name, qty: 1 },
          { stockItemId: chicken.id, stockItemName: chicken.name, qty: 1 },
        ],
      });

      const replaced = await save(StaffRole.OWNER, dishId, [
        { stockItemId: rice.id, qty: 2 },
      ]).expect(200);
      expect((replaced.body as { lines: unknown[] }).lines).toEqual([
        { stockItemId: rice.id, stockItemName: rice.name, qty: 2 },
      ]);

      const list = await request(server())
        .get('/api/v1/staff/kitchen-mappings')
        .query({ pageSize: 100 })
        .set(auth(StaffRole.MANAGER))
        .expect(200);
      const rule = (
        list.body as { data: { menuItemId: string; lines: unknown[] }[] }
      ).data.find((r) => r.menuItemId === dishId);
      expect(rule?.lines).toHaveLength(1);

      const reference = await request(server())
        .get('/api/v1/staff/reference')
        .set(auth(StaffRole.KITCHEN))
        .expect(200);
      expect(
        (
          reference.body as {
            kitchenMappings: { menuItemId: string; lines: unknown[] }[];
          }
        ).kitchenMappings.find((r) => r.menuItemId === dishId),
      ).toEqual({
        menuItemId: dishId,
        lines: [{ stockItemId: rice.id, qty: 2 }],
      });

      const entries = await prisma.auditLog.findMany({
        where: { action: 'mapping.save', ref: dishSlug },
      });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.module === 'Kitchen')).toBe(true);
    });

    it('refuses a drink, a Bar stock item, an empty rule, a repeated portion and a zero', async () => {
      const rice = await kitchenItem();

      const drink = await save(StaffRole.MANAGER, barMenuItemId, [
        { stockItemId: rice.id, qty: 1 },
      ]).expect(400);
      expect(messageOf(drink)).toBe(MAPPING_FOOD_MESSAGE);

      const barPortion = await save(StaffRole.MANAGER, dishId, [
        { stockItemId: barStockId, qty: 1 },
      ]).expect(400);
      expect(messageOf(barPortion)).toBe(MAPPING_PORTION_MESSAGE);

      const empty = await save(StaffRole.MANAGER, dishId, []).expect(400);
      expect(messageOf(empty)).toEqual([LINES_EMPTY_MESSAGE]);

      const twice = await save(StaffRole.MANAGER, dishId, [
        { stockItemId: rice.id, qty: 1 },
        { stockItemId: rice.id, qty: 2 },
      ]).expect(400);
      expect(messageOf(twice)).toEqual([LINES_DUPLICATE_MESSAGE]);

      const zero = await save(StaffRole.MANAGER, dishId, [
        { stockItemId: rice.id, qty: 0 },
      ]).expect(400);
      expect(messageOf(zero)).toEqual([LINES_QTY_MESSAGE]);
    });

    it('is managers only', async () => {
      const rice = await kitchenItem();

      const refused = await save(StaffRole.KITCHEN, dishId, [
        { stockItemId: rice.id, qty: 1 },
      ]).expect(403);
      expect(messageOf(refused)).toBe(ROLE_REFUSED_MESSAGE);

      await request(server())
        .get('/api/v1/staff/kitchen-mappings')
        .set(auth(StaffRole.STOREKEEPER))
        .expect(403);
    });
  });
});
