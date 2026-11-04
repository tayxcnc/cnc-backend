import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  MenuCategoryKind,
  OrderStatus,
  PaymentMethod,
  StaffRole,
  StockKind,
  TableKind,
} from '../generated/cnc-client';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { IDEMPOTENCY_KEY_REQUIRED } from '../src/idempotency/idempotency-key.decorator';
import {
  BAR_NO_DOCKETS_MESSAGE,
  BAR_POS_ONLY_MESSAGE,
  CONFIRM_EMPTY_MESSAGE,
  CONFIRM_OPEN_MESSAGE,
  DEPARTMENT_MESSAGE,
  DOCKET_NOT_FOUND_MESSAGE,
  ITEM_UNAVAILABLE_MESSAGE,
  NO_OPTIONS_MESSAGE,
  ORDER_LOCKED_MESSAGE,
  ORDER_NOT_FOUND_MESSAGE,
  PREVIOUS_DAY_MESSAGE,
  QTY_MAX_MESSAGE,
  QTY_WHOLE_MESSAGE,
  TABLE_MESSAGE,
} from '../src/orders/order-messages';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { drawNumber } from '../src/prisma/sequences';
import { createTestApp } from './create-test-app';
import { createSeededSettingsIfMissing } from './seeded-settings';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * Point of Sale's bills, lines and kitchen dockets (C4-3, C4-4) through
 * HTTP and against Postgres: order.create, order.quantity, order.details,
 * order.confirm, the bill and docket reads, and the history readers for
 * bill and docket refs. The demo's `domain.test.cjs` and
 * `revision.test.cjs` cases that these commands own are ported here, by
 * name.
 *
 * Every dish, table and account is run-unique and never removed; the suite
 * never edits a seeded row. A state the suite cannot reach through C4-3's
 * routes (awaiting payment, a part payment, an order carried from
 * yesterday) is written directly, as C4-5's routes will write it.
 */
describe('Orders and dockets (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  const token: Partial<Record<StaffRole, string>> = {};
  const staffName: Partial<Record<StaffRole, string>> = {};
  const tag = randomUUID().slice(0, 8);

  let vatBps: number;
  let serviceBps: number;
  let tableId: string;
  let tableName: string;
  /** A dish with no choice. */
  let riceId: string;
  /** A dish with a choice of style. */
  let pancakesId: string;
  let pancakesName: string;
  /** A dish not Available for Sale. */
  let offSaleId: string;
  /** A drink, with its paired Bar stock item. */
  let drinkId: string;
  let drinkStockId: string;

  const RICE_PRICE = 650000;
  const PANCAKES_PRICE = 750000;
  const DRINK_PRICE = 250000;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);

    await createSeededSettingsIfMissing(prisma);
    ({ vatBps, serviceBps } = await prisma.settings.findUniqueOrThrow({
      where: { singleton: true },
      select: { vatBps: true, serviceBps: true },
    }));

    const tokens = app.get(CncTokenService, { strict: false });

    for (const role of [
      StaffRole.OWNER,
      StaffRole.MANAGER,
      StaffRole.CASHIER,
      StaffRole.WAITER,
      StaffRole.BARTENDER,
      StaffRole.KITCHEN,
      StaffRole.RECEPTION,
    ]) {
      const account = await createStaffAccount(prisma, role, {
        emailPrefix: 'orders',
        name: `Orders ${role.toLowerCase()} ${tag}`,
      });
      token[role] = await accessTokenFor(tokens, account.id);
      staffName[role] = account.name;
    }

    const venue = await prisma.venue.create({
      data: {
        slug: `orders-${tag}`,
        customerTitle: `Orders ${tag}`,
        staffName: `Orders ${tag}`,
        bigParty: 4,
        sort: 900,
      },
    });
    const table = await prisma.diningTable.create({
      data: {
        venueId: venue.id,
        code: 'B1',
        name: `Booth ${tag}`,
        kind: TableKind.BOOTH,
        capacity: 4,
      },
    });
    tableId = table.id;
    tableName = table.name;

    const category = async (kind: MenuCategoryKind, department: Department) => {
      const menuCategory = await prisma.menuCategory.create({
        data: {
          slug: `orders-${kind.toLowerCase()}-${tag}`,
          title: `Orders ${kind} ${tag}`,
          kind,
          sort: 900,
        },
      });
      const staffCategory = await prisma.staffCategory.create({
        data: {
          name: `Orders ${department} ${tag}`,
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
    const dish = (
      slug: string,
      name: string,
      priceKobo: number,
      extra: {
        active?: boolean;
        choiceLabel?: string;
        choiceOptions?: string[];
      } = {},
    ) =>
      prisma.menuItem.create({
        data: {
          slug: `orders-${slug}-${tag}`,
          department: Department.RESTAURANT,
          ...food,
          name: `${name} ${tag}`,
          priceKobo,
          ...extra,
        },
      });

    riceId = (await dish('rice', 'Jollof Rice', RICE_PRICE)).id;
    const pancakes = await dish('pancakes', 'Pancakes', PANCAKES_PRICE, {
      choiceLabel: 'Style',
      choiceOptions: ['Suya beef', 'Sweet with Plateau honey'],
    });
    pancakesId = pancakes.id;
    pancakesName = pancakes.name;
    offSaleId = (await dish('off', 'Off Sale', 100000, { active: false })).id;

    const drinks = await category(MenuCategoryKind.DRINKS, Department.BAR);
    const drink = await prisma.menuItem.create({
      data: {
        slug: `orders-drink-${tag}`,
        department: Department.BAR,
        ...drinks,
        name: `Orders Drink ${tag}`,
        priceKobo: DRINK_PRICE,
      },
    });
    drinkId = drink.id;
    drinkStockId = (
      await prisma.stockItem.create({
        data: {
          name: `Orders Drink ${tag}`,
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
  const today = () => watToday(new Date());

  interface Line {
    id: string;
    menuItemId: string;
    name: string;
    option: string;
    qty: number;
    unitPriceKobo: number;
    lineTotalKobo: number;
    department: Department;
  }

  interface Docket {
    id: string;
    ref: string;
    orderId: string;
    orderNumber: string;
    revision: number;
    businessDate: string;
    items: {
      menuItemId: string;
      name: string;
      option: string;
      qty: number;
      unitPriceKobo: number;
    }[];
    notes: string;
    staffName: string | null;
    channel: string;
    cancellation: boolean;
  }

  interface Order {
    id: string;
    number: string;
    department: Department;
    status: OrderStatus;
    table: { id: string; code: string; name: string } | null;
    label: string;
    guest: string;
    notes: string;
    businessDate: string;
    revision: number;
    vatBps: number;
    serviceBps: number;
    openedByName: string | null;
    editable: boolean;
    unsentChanges: boolean;
    partPaid: boolean;
    lines: Line[];
    totals: {
      subtotalKobo: number;
      vatKobo: number;
      totalKobo: number;
      paidKobo: number;
      balanceKobo: number;
    };
    payments: { number: string; amountKobo: number }[];
    latestDocket: Docket | null;
    version: number;
  }

  interface Summary {
    id: string;
    number: string;
    status: OrderStatus;
    tableCode: string | null;
    lineCount: number;
    totalKobo: number;
    paidKobo: number;
    balanceKobo: number;
    partPaid: boolean;
  }

  interface Page<T> {
    data: T[];
    total: number;
    counts?: Record<string, number>;
  }

  const create = (
    role: StaffRole,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) =>
    request(server())
      .post('/api/v1/staff/orders')
      .set(auth(role))
      .set('Idempotency-Key', key)
      .send(body);

  const open = async (
    department: Department = Department.RESTAURANT,
    body: Record<string, unknown> = {},
    role: StaffRole = StaffRole.WAITER,
  ): Promise<Order> =>
    (await create(role, { department, ...body }).expect(201)).body as Order;

  const setLine = (
    role: StaffRole,
    order: Pick<Order, 'id' | 'version'>,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .put(`/api/v1/staff/orders/${order.id}/lines`)
      .set(auth(role))
      .send({ version: order.version, ...body });

  /** Set a line and return the bill as answered. */
  const line = async (
    order: Pick<Order, 'id' | 'version'>,
    body: Record<string, unknown>,
    role: StaffRole = StaffRole.WAITER,
  ): Promise<Order> =>
    (await setLine(role, order, body).expect(200)).body as Order;

  const confirm = (role: StaffRole, order: Pick<Order, 'id' | 'version'>) =>
    request(server())
      .post(`/api/v1/staff/orders/${order.id}/confirm`)
      .set(auth(role))
      .send({ version: order.version });

  const details = (
    role: StaffRole,
    order: Pick<Order, 'id' | 'version'>,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .patch(`/api/v1/staff/orders/${order.id}`)
      .set(auth(role))
      .send({ version: order.version, ...body });

  const read = async (id: string, role: StaffRole = StaffRole.WAITER) =>
    (
      await request(server())
        .get(`/api/v1/staff/orders/${id}`)
        .set(auth(role))
        .expect(200)
    ).body as Order;

  const list = (role: StaffRole, query: Record<string, string>) =>
    request(server()).get('/api/v1/staff/orders').set(auth(role)).query(query);

  /** Put a bill in a state C4-5's routes reach, as they would write it. */
  const setState = async (
    id: string,
    data: { status?: OrderStatus; businessDate?: Date },
  ) => {
    await prisma.order.update({ where: { id }, data });
    return read(id);
  };

  describe('order.create', () => {
    it('restaurant and bar keep independent sequential references', async () => {
      const a = await open(Department.RESTAURANT);
      const b = await open(Department.BAR);
      const c = await open(Department.RESTAURANT);

      expect(a.number).toMatch(/^CNCR-\d{6,}$/);
      expect(b.number).toMatch(/^CNCB-\d{6,}$/);
      expect(c.number).toMatch(/^CNCR-\d{6,}$/);
      expect(Number(c.number.slice(5))).toBeGreaterThan(
        Number(a.number.slice(5)),
      );
    });

    it('fixes today’s date and the current rates on the bill', async () => {
      const order = await open(Department.RESTAURANT, { tableId });

      expect(order).toMatchObject({
        status: OrderStatus.OPEN,
        businessDate: formatIsoDate(today()),
        vatBps,
        serviceBps,
        revision: 0,
        label: tableName,
        table: { id: tableId, code: 'B1', name: tableName },
        openedByName: staffName[StaffRole.WAITER],
        editable: true,
        lines: [],
        latestDocket: null,
        version: 0,
      });
    });

    it('labels a bill with no table "Order <n>", or the label given', async () => {
      const plain = await open(Department.BAR, {}, StaffRole.BARTENDER);
      expect(plain.label).toBe(`Order ${Number(plain.number.slice(5))}`);
      expect(plain.table).toBeNull();

      const named = await open(Department.BAR, {
        tableId,
        label: 'Window',
        guest: 'Ada',
      });
      expect(named).toMatchObject({ label: 'Window', guest: 'Ada' });
    });

    it('needs an Idempotency-Key, and a retry opens one bill', async () => {
      const missing = await request(server())
        .post('/api/v1/staff/orders')
        .set(auth(StaffRole.CASHIER))
        .send({ department: Department.RESTAURANT })
        .expect(400);
      expect(messageOf(missing)).toBe(IDEMPOTENCY_KEY_REQUIRED);

      const key = randomUUID();
      const first = await create(
        StaffRole.CASHIER,
        { department: Department.RESTAURANT, guest: `Retry ${tag}` },
        key,
      ).expect(201);
      const again = await create(
        StaffRole.CASHIER,
        { department: Department.RESTAURANT, guest: `Retry ${tag}` },
        key,
      ).expect(201);

      expect((again.body as Order).id).toBe((first.body as Order).id);
      await expect(
        prisma.order.count({ where: { guest: `Retry ${tag}` } }),
      ).resolves.toBe(1);
    });

    it('refuses a missing department and a table that does not exist', async () => {
      const noDepartment = await create(StaffRole.WAITER, {}).expect(400);
      expect(messageOf(noDepartment)).toEqual([DEPARTMENT_MESSAGE]);

      const badTable = await create(StaffRole.WAITER, {
        department: Department.RESTAURANT,
        tableId: 'no-such-table',
      }).expect(400);
      expect(messageOf(badTable)).toBe(TABLE_MESSAGE);
    });

    it('lets a Bartender open Bar bills only, and no other role in', async () => {
      const refused = await create(StaffRole.BARTENDER, {
        department: Department.RESTAURANT,
      }).expect(403);
      expect(messageOf(refused)).toBe(BAR_POS_ONLY_MESSAGE);

      for (const role of [StaffRole.KITCHEN, StaffRole.RECEPTION]) {
        const response = await create(role, {
          department: Department.BAR,
        }).expect(403);
        expect(messageOf(response)).toBe(ROLE_REFUSED_MESSAGE);
      }

      await open(Department.BAR, {}, StaffRole.MANAGER);
    });
  });

  describe('order.quantity', () => {
    it('dishes with options need one, keep each choice as its own line and print it on the docket', async () => {
      let order = await open();

      const none = await setLine(StaffRole.WAITER, order, {
        menuItemId: pancakesId,
        qty: 1,
      }).expect(400);
      expect(messageOf(none)).toBe(`Choose style for ${pancakesName}.`);

      const nonsense = await setLine(StaffRole.WAITER, order, {
        menuItemId: pancakesId,
        option: 'Nonsense',
        qty: 1,
      }).expect(400);
      expect(messageOf(nonsense)).toBe(`Choose style for ${pancakesName}.`);

      order = await line(order, {
        menuItemId: pancakesId,
        option: 'Suya beef',
        qty: 2,
      });
      order = await line(order, {
        menuItemId: pancakesId,
        option: 'Sweet with Plateau honey',
        qty: 1,
      });
      expect(order.lines).toHaveLength(2);

      order = await line(order, {
        menuItemId: pancakesId,
        option: 'Suya beef',
        qty: 3,
      });
      expect(order.lines.find((l) => l.option === 'Suya beef')?.qty).toBe(3);
      expect(order.totals.subtotalKobo).toBe(4 * PANCAKES_PRICE);

      order = await line(order, {
        menuItemId: pancakesId,
        option: 'Sweet with Plateau honey',
        qty: 0,
      });
      expect(order.lines.map((l) => l.option)).toEqual(['Suya beef']);

      const noOptions = await setLine(StaffRole.WAITER, order, {
        menuItemId: riceId,
        option: 'Medium',
        qty: 1,
      }).expect(400);
      expect(messageOf(noOptions)).toBe(NO_OPTIONS_MESSAGE);

      const sent = (await confirm(StaffRole.WAITER, order).expect(200))
        .body as { docket: Docket };
      expect(sent.docket.items).toEqual([
        {
          menuItemId: pancakesId,
          name: pancakesName,
          option: 'Suya beef',
          qty: 3,
          unitPriceKobo: PANCAKES_PRICE,
        },
      ]);
    });

    it('takes whole quantities from 0 to 999', async () => {
      const order = await open();

      for (const qty of [-1, 1.5, '2']) {
        const response = await setLine(StaffRole.WAITER, order, {
          menuItemId: riceId,
          qty,
        }).expect(400);
        expect(messageOf(response)).toEqual([QTY_WHOLE_MESSAGE]);
      }

      const tooMany = await setLine(StaffRole.WAITER, order, {
        menuItemId: riceId,
        qty: 1000,
      }).expect(400);
      expect(messageOf(tooMany)).toEqual([QTY_MAX_MESSAGE]);

      const most = await line(order, { menuItemId: riceId, qty: 999 });
      expect(most.lines[0].qty).toBe(999);
    });

    it('refuses a dish off sale or of the other department, but lets a line go to zero', async () => {
      let order = await open();

      for (const menuItemId of [offSaleId, drinkId, 'no-such-dish']) {
        const response = await setLine(StaffRole.WAITER, order, {
          menuItemId,
          qty: 1,
        }).expect(400);
        expect(messageOf(response)).toBe(ITEM_UNAVAILABLE_MESSAGE);
      }

      // A dish taken off sale after it was added can still be removed.
      order = await line(order, { menuItemId: riceId, qty: 2 });
      await prisma.menuItem.update({
        where: { id: riceId },
        data: { active: false },
      });

      try {
        const refused = await setLine(StaffRole.WAITER, order, {
          menuItemId: riceId,
          qty: 3,
        }).expect(400);
        expect(messageOf(refused)).toBe(ITEM_UNAVAILABLE_MESSAGE);

        order = await line(order, { menuItemId: riceId, qty: 0 });
        expect(order.lines).toEqual([]);
      } finally {
        await prisma.menuItem.update({
          where: { id: riceId },
          data: { active: true },
        });
      }
    });

    it('keeps the price a line was added at; a new line takes the new price', async () => {
      let order = await open();
      order = await line(order, { menuItemId: riceId, qty: 1 });

      await prisma.menuItem.update({
        where: { id: riceId },
        data: { priceKobo: RICE_PRICE + 50000 },
      });

      try {
        order = await line(order, { menuItemId: riceId, qty: 2 });
        expect(order.lines[0]).toMatchObject({
          qty: 2,
          unitPriceKobo: RICE_PRICE,
          lineTotalKobo: 2 * RICE_PRICE,
        });

        order = await line(order, { menuItemId: riceId, qty: 0 });
        order = await line(order, { menuItemId: riceId, qty: 1 });
        expect(order.lines[0].unitPriceKobo).toBe(RICE_PRICE + 50000);
      } finally {
        await prisma.menuItem.update({
          where: { id: riceId },
          data: { priceKobo: RICE_PRICE },
        });
      }
    });

    it('computes the bill’s totals from its lines and the rates fixed on it', async () => {
      let order = await open();
      order = await line(order, { menuItemId: riceId, qty: 2 });

      const subtotal = 2 * RICE_PRICE;
      const service = Math.round((subtotal * serviceBps) / 10000);
      const vat = Math.round(((subtotal + service) * vatBps) / 10000);

      expect(order.totals).toMatchObject({
        subtotalKobo: subtotal,
        vatKobo: vat,
        totalKobo: subtotal + service + vat,
        paidKobo: 0,
        balanceKobo: subtotal + service + vat,
      });
    });

    it('bar edits do not deduct stock', async () => {
      let order = await open(Department.BAR, {}, StaffRole.BARTENDER);
      order = await line(
        order,
        { menuItemId: drinkId, qty: 2 },
        StaffRole.BARTENDER,
      );
      order = await line(
        order,
        { menuItemId: drinkId, qty: 3 },
        StaffRole.BARTENDER,
      );

      expect(order.lines[0]).toMatchObject({
        qty: 3,
        department: Department.BAR,
      });
      await expect(
        prisma.stockMovement.count({ where: { stockItemId: drinkStockId } }),
      ).resolves.toBe(0);
      await expect(
        prisma.stockBalance.count({ where: { stockItemId: drinkStockId } }),
      ).resolves.toBe(0);
    });

    it('a stale version is refused and changes nothing', async () => {
      const order = await open();
      await line(order, { menuItemId: riceId, qty: 1 });

      const stale = await setLine(StaffRole.WAITER, order, {
        menuItemId: riceId,
        qty: 5,
      }).expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);
      expect((await read(order.id)).lines[0].qty).toBe(1);
    });

    it('payment handoff locks items until a manager reopens', async () => {
      let order = await open();
      order = await line(order, { menuItemId: riceId, qty: 1 });
      order = await setState(order.id, { status: OrderStatus.PAYMENT });
      expect(order.editable).toBe(false);

      const locked = await setLine(StaffRole.WAITER, order, {
        menuItemId: riceId,
        qty: 2,
      }).expect(409);
      expect(messageOf(locked)).toBe(ORDER_LOCKED_MESSAGE);

      // A manager is held to the same rule: only a reopen unlocks it.
      const manager = await setLine(StaffRole.MANAGER, order, {
        menuItemId: riceId,
        qty: 2,
      }).expect(409);
      expect(messageOf(manager)).toBe(ORDER_LOCKED_MESSAGE);
    });

    it('midnight freezes yesterday’s items', async () => {
      let order = await open();
      order = await line(order, { menuItemId: riceId, qty: 1 });
      order = await setState(order.id, { businessDate: addDays(today(), -1) });

      const frozen = await setLine(StaffRole.WAITER, order, {
        menuItemId: riceId,
        qty: 2,
      }).expect(409);
      expect(messageOf(frozen)).toBe(PREVIOUS_DAY_MESSAGE);
    });

    it('answers a bill that does not exist, and keeps a Bartender at the Bar', async () => {
      const missing = await setLine(
        StaffRole.WAITER,
        { id: 'no-such-order', version: 0 },
        { menuItemId: riceId, qty: 1 },
      ).expect(404);
      expect(messageOf(missing)).toBe(ORDER_NOT_FOUND_MESSAGE);

      const food = await open();
      const refused = await setLine(StaffRole.BARTENDER, food, {
        menuItemId: riceId,
        qty: 1,
      }).expect(403);
      expect(messageOf(refused)).toBe(BAR_POS_ONLY_MESSAGE);

      const kitchen = await setLine(StaffRole.KITCHEN, food, {
        menuItemId: riceId,
        qty: 1,
      }).expect(403);
      expect(messageOf(kitchen)).toBe(ROLE_REFUSED_MESSAGE);
    });
  });

  describe('order.details', () => {
    it('changes only the fields sent, on an open bill of today', async () => {
      let order = await open();

      order = (
        await details(StaffRole.WAITER, order, {
          guest: 'Ada',
          notes: 'No pepper',
        }).expect(200)
      ).body as Order;
      expect(order).toMatchObject({ guest: 'Ada', notes: 'No pepper' });

      order = (
        await details(StaffRole.WAITER, order, {
          notes: 'Extra pepper',
        }).expect(200)
      ).body as Order;
      expect(order).toMatchObject({ guest: 'Ada', notes: 'Extra pepper' });

      const nulled = await details(StaffRole.WAITER, order, {
        guest: null,
      }).expect(400);
      expect(messageOf(nulled)).toEqual(['guest must be text.']);

      order = await setState(order.id, { status: OrderStatus.PAYMENT });
      const locked = await details(StaffRole.WAITER, order, {
        guest: 'Bola',
      }).expect(409);
      expect(messageOf(locked)).toBe(ORDER_LOCKED_MESSAGE);
    });
  });

  describe('order.confirm', () => {
    it('food confirm creates immutable full-list docket revisions without kitchen deduction', async () => {
      let order = await open(Department.RESTAURANT, { tableId });
      order = await line(order, { menuItemId: riceId, qty: 2 });
      order = await line(order, {
        menuItemId: pancakesId,
        option: 'Suya beef',
        qty: 1,
      });
      expect(order.unsentChanges).toBe(true);

      const first = (await confirm(StaffRole.WAITER, order).expect(200))
        .body as { reprint: boolean; docket: Docket; order: Order };
      expect(first.reprint).toBe(false);
      expect(first.docket).toMatchObject({
        ref: `KOT-${order.number}`,
        orderNumber: order.number,
        revision: 1,
        businessDate: formatIsoDate(today()),
        staffName: staffName[StaffRole.WAITER],
        channel: 'POS',
        cancellation: false,
      });
      expect(first.docket.items.map((item) => item.qty)).toEqual([2, 1]);
      expect(first.order).toMatchObject({
        revision: 1,
        unsentChanges: false,
        latestDocket: { revision: 1 },
      });
      const revisionOne = await prisma.docket.findFirstOrThrow({
        where: { orderId: order.id, revision: 1 },
      });

      order = await line(first.order, { menuItemId: riceId, qty: 3 });
      expect(order.unsentChanges).toBe(true);

      const second = (await confirm(StaffRole.WAITER, order).expect(200))
        .body as { reprint: boolean; docket: Docket; order: Order };
      expect(second.docket.revision).toBe(2);
      expect(second.docket.ref).toBe(`KOT-${order.number}`);
      expect(second.docket.items.map((item) => item.qty)).toEqual([3, 1]);
      await expect(
        prisma.docket.findFirstOrThrow({
          where: { orderId: order.id, revision: 1 },
        }),
      ).resolves.toEqual(revisionOne);

      const reprint = (
        await confirm(StaffRole.WAITER, second.order).expect(200)
      ).body as { reprint: boolean; docket: Docket; order: Order };
      expect(reprint.reprint).toBe(true);
      expect(reprint.docket.revision).toBe(2);
      expect(reprint.order.revision).toBe(2);
      await expect(
        prisma.docket.count({ where: { orderId: order.id } }),
      ).resolves.toBe(2);

      // Nothing reached the kitchen's stock: the kitchen records its own.
      await expect(
        prisma.stockMovement.count({
          where: { ref: { contains: order.number } },
        }),
      ).resolves.toBe(0);
    });

    it('prints the order notes on the docket', async () => {
      let order = await open();
      order = await line(order, { menuItemId: riceId, qty: 1 });
      order = (
        await details(StaffRole.WAITER, order, {
          notes: 'Allergy: nuts',
        }).expect(200)
      ).body as Order;

      const sent = (await confirm(StaffRole.WAITER, order).expect(200))
        .body as { docket: Docket };
      expect(sent.docket.notes).toBe('Allergy: nuts');
    });

    it('refuses an empty bill, a Bar bill and a bill that is not open', async () => {
      const empty = await open();
      const none = await confirm(StaffRole.WAITER, empty).expect(409);
      expect(messageOf(none)).toBe(CONFIRM_EMPTY_MESSAGE);

      let drinks = await open(Department.BAR);
      drinks = await line(drinks, { menuItemId: drinkId, qty: 1 });
      const bar = await confirm(StaffRole.WAITER, drinks).expect(409);
      expect(messageOf(bar)).toBe(BAR_NO_DOCKETS_MESSAGE);
      await expect(
        prisma.docket.count({ where: { orderId: drinks.id } }),
      ).resolves.toBe(0);

      let food = await open();
      food = await line(food, { menuItemId: riceId, qty: 1 });
      food = await setState(food.id, { status: OrderStatus.PAYMENT });
      const notOpen = await confirm(StaffRole.WAITER, food).expect(409);
      expect(messageOf(notOpen)).toBe(CONFIRM_OPEN_MESSAGE);
    });

    it('a carried order may confirm its frozen items after midnight, under its own date', async () => {
      let order = await open();
      order = await line(order, { menuItemId: riceId, qty: 1 });
      const yesterday = addDays(today(), -1);
      order = await setState(order.id, { businessDate: yesterday });

      const sent = (await confirm(StaffRole.WAITER, order).expect(200))
        .body as { docket: Docket };
      expect(sent.docket.businessDate).toBe(formatIsoDate(yesterday));
    });

    it('two confirms of one version: one writes the revision, the other is stale', async () => {
      let order = await open();
      order = await line(order, { menuItemId: riceId, qty: 1 });

      const results = await Promise.all([
        confirm(StaffRole.WAITER, order),
        confirm(StaffRole.CASHIER, order),
      ]);
      const statuses = results.map((response) => response.status).sort();

      expect(statuses).toEqual([200, 409]);
      expect(
        messageOf(results.find((response) => response.status === 409)!),
      ).toBe(STALE_VERSION_MESSAGE);
      await expect(
        prisma.docket.count({ where: { orderId: order.id } }),
      ).resolves.toBe(1);
    });

    it('keeps a Bartender away from Restaurant dockets', async () => {
      let order = await open();
      order = await line(order, { menuItemId: riceId, qty: 1 });

      const refused = await confirm(StaffRole.BARTENDER, order).expect(403);
      expect(messageOf(refused)).toBe(BAR_POS_ONLY_MESSAGE);
    });
  });

  describe('docket reads', () => {
    let sent: Docket;

    beforeAll(async () => {
      let order = await open();
      order = await line(order, { menuItemId: riceId, qty: 1 });
      const first = (await confirm(StaffRole.WAITER, order).expect(200))
        .body as { order: Order };
      order = await line(first.order, { menuItemId: riceId, qty: 2 });
      sent = (
        (await confirm(StaffRole.WAITER, order).expect(200)).body as {
          docket: Docket;
        }
      ).docket;
    });

    it('finds the latest revision by the number typed from paper', async () => {
      const response = await request(server())
        .get(
          `/api/v1/staff/dockets/${encodeURIComponent(` ${sent.ref.toLowerCase()} `)}`,
        )
        .set(auth(StaffRole.KITCHEN))
        .expect(200);

      expect(response.body).toMatchObject({
        ref: sent.ref,
        revision: 2,
        items: [{ menuItemId: riceId, qty: 2 }],
      });
    });

    it('answers a number nobody printed with the kitchen’s sentence', async () => {
      const response = await request(server())
        .get('/api/v1/staff/dockets/KOT-UNKNOWN')
        .set(auth(StaffRole.KITCHEN))
        .expect(404);

      expect(messageOf(response)).toBe(DOCKET_NOT_FOUND_MESSAGE);
    });

    it('lists the day’s dockets, the latest revision of each', async () => {
      const response = await request(server())
        .get('/api/v1/staff/dockets')
        .query({ date: formatIsoDate(today()), pageSize: '100' })
        .set(auth(StaffRole.KITCHEN))
        .expect(200);
      const page = response.body as Page<Docket>;
      const ours = page.data.filter((docket) => docket.ref === sent.ref);

      // Newest first, so a docket confirmed in this run is on the first page
      // unless a hundred others were written after it.
      expect(ours).toHaveLength(1);
      expect(ours[0].revision).toBe(2);

      const web = await request(server())
        .get('/api/v1/staff/dockets')
        .query({ channel: 'WEB', date: formatIsoDate(today()) })
        .set(auth(StaffRole.CASHIER))
        .expect(200);
      expect(
        (web.body as Page<Docket>).data.every((d) => d.channel === 'WEB'),
      ).toBe(true);
    });

    it('is for the Kitchen and the Restaurant till, not the Bar', async () => {
      await request(server())
        .get(`/api/v1/staff/dockets/${sent.ref}`)
        .set(auth(StaffRole.BARTENDER))
        .expect(403);
      await request(server())
        .get('/api/v1/staff/dockets')
        .set(auth(StaffRole.RECEPTION))
        .expect(403);
    });
  });

  describe('the till’s reads', () => {
    let fresh: Order;
    let awaiting: Order;
    let partPaid: Order;
    let carried: Order;

    beforeAll(async () => {
      const onTable = () =>
        open(Department.RESTAURANT, { tableId, guest: `Q ${tag}` });

      fresh = await onTable();
      fresh = await line(fresh, { menuItemId: riceId, qty: 1 });

      awaiting = await onTable();
      awaiting = await line(awaiting, { menuItemId: riceId, qty: 1 });
      awaiting = await setState(awaiting.id, { status: OrderStatus.PAYMENT });

      partPaid = await onTable();
      partPaid = await line(partPaid, { menuItemId: riceId, qty: 2 });
      partPaid = await setState(partPaid.id, { status: OrderStatus.PAYMENT });
      await prisma.payment.create({
        data: {
          number: await drawNumber(prisma, 'payment'),
          orderId: partPaid.id,
          method: PaymentMethod.CASH,
          amountKobo: 100000,
          part: true,
          businessDate: today(),
        },
      });

      carried = await onTable();
      carried = await setState(carried.id, {
        businessDate: addDays(today(), -1),
      });
    });

    const numbers = async (query: Record<string, string>) => {
      const response = await list(StaffRole.CASHIER, {
        department: Department.RESTAURANT,
        tableId,
        pageSize: '100',
        ...query,
      }).expect(200);

      return (response.body as Page<Summary>).data.map((row) => row.number);
    };

    it('filters the active bills by the till’s chips', async () => {
      const all = await numbers({});
      for (const order of [fresh, awaiting, partPaid, carried]) {
        expect(all).toContain(order.number);
      }

      const unsettled = await numbers({ filter: 'UNSETTLED' });
      expect(unsettled).toContain(fresh.number);
      expect(unsettled).not.toContain(awaiting.number);

      const waiting = await numbers({ filter: 'AWAITING_PAYMENT' });
      expect(waiting).toContain(awaiting.number);
      expect(waiting).not.toContain(partPaid.number);

      expect(await numbers({ filter: 'PART_PAID' })).toEqual([partPaid.number]);

      const previous = await numbers({ filter: 'PREVIOUS_DAYS' });
      expect(previous).toContain(carried.number);
      expect(previous).not.toContain(fresh.number);

      expect(await numbers({ q: fresh.number.toLowerCase() })).toEqual([
        fresh.number,
      ]);
      expect(await numbers({ state: 'SETTLED' })).toEqual([]);
    });

    it('shows each bill’s money and the chip counts', async () => {
      const response = await list(StaffRole.CASHIER, {
        department: Department.RESTAURANT,
        tableId,
        filter: 'PART_PAID',
      }).expect(200);
      const page = response.body as Page<Summary>;

      expect(page.data[0]).toMatchObject({
        number: partPaid.number,
        tableCode: 'B1',
        lineCount: 1,
        totalKobo: partPaid.totals.totalKobo,
        paidKobo: 100000,
        balanceKobo: partPaid.totals.totalKobo - 100000,
        partPaid: true,
      });
      expect(page.counts?.partPaid).toBeGreaterThanOrEqual(1);
      expect(page.counts?.previousDays).toBeGreaterThanOrEqual(1);
      expect(page.counts?.all).toBeGreaterThanOrEqual(4);

      const detail = await read(partPaid.id, StaffRole.CASHIER);
      expect(detail).toMatchObject({
        partPaid: true,
        totals: { paidKobo: 100000 },
        payments: [{ amountKobo: 100000 }],
      });
    });

    it('needs a department, and keeps a Bartender at the Bar', async () => {
      const none = await list(StaffRole.CASHIER, {}).expect(400);
      expect(messageOf(none)).toEqual([DEPARTMENT_MESSAGE]);

      const refused = await list(StaffRole.BARTENDER, {
        department: Department.RESTAURANT,
      }).expect(403);
      expect(messageOf(refused)).toBe(BAR_POS_ONLY_MESSAGE);
      await list(StaffRole.BARTENDER, { department: Department.BAR }).expect(
        200,
      );

      await request(server())
        .get(`/api/v1/staff/orders/${fresh.id}`)
        .set(auth(StaffRole.BARTENDER))
        .expect(403);
      await request(server())
        .get(`/api/v1/staff/orders/${fresh.id}`)
        .set(auth(StaffRole.KITCHEN))
        .expect(403);
      const missing = await request(server())
        .get('/api/v1/staff/orders/no-such-order')
        .set(auth(StaffRole.CASHIER))
        .expect(404);
      expect(messageOf(missing)).toBe(ORDER_NOT_FOUND_MESSAGE);
    });
  });

  describe('history', () => {
    let order: Order;
    let docketRef: string;

    beforeAll(async () => {
      order = await open();
      order = await line(order, { menuItemId: riceId, qty: 1 });
      const sent = (await confirm(StaffRole.WAITER, order).expect(200))
        .body as { docket: Docket };
      docketRef = sent.docket.ref;
    });

    const history = (role: StaffRole, ref: string) =>
      request(server())
        .get('/api/v1/staff/audit')
        .query({ ref })
        .set(auth(role));

    it('lets the Point of Sale roles read a bill’s history in plain words', async () => {
      const response = await history(StaffRole.CASHIER, order.number).expect(
        200,
      );
      const rows = (
        response.body as Page<{
          action: string;
          actionLabel: string;
          module: string;
          changes: string[];
        }>
      ).data;

      expect(rows.map((row) => row.action).sort()).toEqual([
        'order.confirm',
        'order.create',
        'order.quantity',
      ]);
      expect(rows.every((row) => row.module === 'Point of Sale')).toBe(true);
      expect(
        rows.find((row) => row.action === 'order.quantity')?.changes,
      ).toContain('Order items updated (1 lines).');
      expect(
        rows.find((row) => row.action === 'order.confirm')?.changes,
      ).toContain(`Docket: ${docketRef}.`);
    });

    it('keeps a Bartender to Bar bills and the Kitchen to dockets', async () => {
      const bartender = await history(StaffRole.BARTENDER, order.number).expect(
        403,
      );
      expect(messageOf(bartender)).toBe(ROLE_REFUSED_MESSAGE);
      await history(StaffRole.KITCHEN, order.number).expect(403);
      await history(StaffRole.RECEPTION, order.number).expect(403);

      await history(StaffRole.KITCHEN, docketRef).expect(200);
      await history(StaffRole.BARTENDER, docketRef).expect(403);

      const bar = await open(Department.BAR, {}, StaffRole.BARTENDER);
      await history(StaffRole.BARTENDER, bar.number).expect(200);

      // A number nobody issued has no history to read.
      await history(StaffRole.CASHIER, 'CNCR-999999999').expect(403);
    });
  });
});
