import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  OrderStatus,
  PaymentMethod,
  StaffRole,
  StockLocation,
  StockMovementType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import {
  approvalLimitMessage,
  LIMITED_DECISIONS,
  OWNER_ONLY_ACTIONS,
  ownerOnlyMessage,
} from '../src/money-control/money-control.service';
import { PREVIOUS_DAY_MESSAGE } from '../src/orders/order-messages';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp } from './create-test-app';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * The demo's C4 cases (card C4-9) that no command suite had ported by
 * name, kept to the demo's expectations, through HTTP and against Postgres.
 *
 * Where each other C4 case of `cnc-frontend/staff/tests` lives:
 * - `orders.e2e-spec.ts`: independent sequences, dishes with options,
 *   bar edits, the payment handoff lock, midnight's frozen items,
 *   immutable docket revisions, the carried order;
 * - `order-payments.e2e-spec.ts`: every `payments.test.cjs` case, bar
 *   stock on settle, atomic validation, insufficient stock, unconfirmed
 *   food, food settlement, the cancellation docket, deposit credit, the
 *   reversal, split settlement, the empty generated bill, only the Owner
 *   reverses, discounts above the limit;
 * - `kitchen.e2e-spec.ts`: one docket number, kitchen corrections,
 *   duplicate dockets, closed and previous days (as "closes the current
 *   day only, once, and a closed day needs logged manager corrections"
 *   and "a previous day's docket needs a manager's correction with a
 *   reason"), the reason on a date correction, the crosscheck;
 * - `stock.e2e-spec.ts`: stock count, Correct Balance, only the Owner
 *   corrects a balance;
 * - `reception.e2e-spec.ts`: every reservation and seating case.
 *
 * This file also holds the two cases that read or change the settings row
 * (the settings defaults, and `owner.test.cjs`'s "a lowered limit applies
 * at once"), which only a suite with a database of its own may touch.
 *
 * Cases of the same files that belong to later cards (requests,
 * purchases, waste, tasks, online orders, attendance) are ported with
 * those cards.
 *
 * It runs on a database of its own, seeded with the real menu, because it
 * moves the clock across a Lagos midnight: the bills it dates there must
 * not meet another suite's day. **The clock is Jest's fake `Date` only**
 * (every timer stays real), set forward from the real time, so the server
 * reads the same instant the test names.
 */
describe('C4 demo ports (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  const originalUrl = process.env.CNC_DB_URL;

  type Actor =
    | 'owner'
    | 'manager'
    | 'cashier'
    | 'waiter'
    | 'kitchen'
    | 'bartender'
    | 'storekeeper';

  const ROLE: Record<Actor, StaffRole> = {
    owner: StaffRole.OWNER,
    manager: StaffRole.MANAGER,
    cashier: StaffRole.CASHIER,
    waiter: StaffRole.WAITER,
    kitchen: StaffRole.KITCHEN,
    bartender: StaffRole.BARTENDER,
    storekeeper: StaffRole.STOREKEEPER,
  };

  const staffId: Partial<Record<Actor, string>> = {};
  const token: Partial<Record<Actor, string>> = {};

  interface Order {
    id: string;
    number: string;
    status: OrderStatus;
    businessDate: string;
    totals: { totalKobo: number; balanceKobo: number };
    version: number;
  }

  interface Drink {
    menuItemId: string;
    stockItemId: string;
    name: string;
    factor: number;
  }

  /** Seeded drinks with their Bar stock items, one per test that moves stock. */
  let drinks: Drink[];

  async function mintTokens(): Promise<void> {
    for (const actor of Object.keys(ROLE) as Actor[]) {
      token[actor] = await accessTokenFor(tokens, staffId[actor]!);
    }
  }

  /** Move the fake clock forward to `at`, with tokens that live there. */
  async function moveClockTo(at: number): Promise<void> {
    if (at <= Date.now()) throw new Error('The clock only moves forward.');

    jest.setSystemTime(at);
    await mintTokens();
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);

    for (const actor of Object.keys(ROLE) as Actor[]) {
      staffId[actor] = (
        await createStaffAccount(prisma, ROLE[actor], {
          emailPrefix: 'c4-ports',
          name: `Ports ${actor}`,
        })
      ).id;
    }

    drinks = (
      await prisma.menuItem.findMany({
        where: {
          department: Department.BAR,
          active: true,
          stockItem: { isNot: null },
        },
        orderBy: { slug: 'asc' },
        take: 5,
        select: {
          id: true,
          stockItem: { select: { id: true, name: true, factor: true } },
        },
      })
    ).map((item) => ({
      menuItemId: item.id,
      stockItemId: item.stockItem!.id,
      name: item.stockItem!.name,
      factor: item.stockItem!.factor,
    }));

    // Only Date is faked; it runs on from the real time until a test moves it.
    jest.useFakeTimers({
      now: Date.now(),
      advanceTimers: true,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    await mintTokens();
  }, 120_000);

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const as = (actor: Actor) => ({ Authorization: `Bearer ${token[actor]}` });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  async function countTo(
    location: StockLocation,
    stockItemId: string,
    counted: number,
  ): Promise<void> {
    await request(server())
      .post('/api/v1/staff/stock/counts')
      .set(as('owner'))
      .send({ location, counts: [{ stockItemId, counted }] })
      .expect(201);
  }

  const balance = async (stockItemId: string, location: StockLocation) =>
    (
      await prisma.stockBalance.findUnique({
        where: { stockItemId_location: { stockItemId, location } },
        select: { qty: true },
      })
    )?.qty ?? 0;

  const open = async (actor: Actor, department: Department) =>
    (
      await request(server())
        .post('/api/v1/staff/orders')
        .set(as(actor))
        .set('Idempotency-Key', randomUUID())
        .send({ department })
        .expect(201)
    ).body as Order;

  const quantity = (
    actor: Actor,
    order: Order,
    menuItemId: string,
    qty: number,
  ) =>
    request(server())
      .put(`/api/v1/staff/orders/${order.id}/lines`)
      .set(as(actor))
      .send({ version: order.version, menuItemId, qty });

  const command = (
    actor: Actor,
    order: Order,
    path: string,
    body: Record<string, unknown> = {},
    key?: string,
  ) => {
    const call = request(server())
      .post(`/api/v1/staff/orders/${order.id}/${path}`)
      .set(as(actor));

    if (key !== undefined) call.set('Idempotency-Key', key);

    return call.send({ version: order.version, ...body });
  };

  /** The demo's `barOrder`: a Bar bill of `qty` of one drink. */
  async function barOrder(drink: Drink, qty = 2): Promise<Order> {
    return (
      await quantity(
        'manager',
        await open('manager', Department.BAR),
        drink.menuItemId,
        qty,
      ).expect(200)
    ).body as Order;
  }

  /** The demo's `settle`: one cash payment of the whole balance. */
  const settle = (actor: Actor, order: Order) =>
    command(
      actor,
      order,
      'settle',
      {
        payments: [
          { method: PaymentMethod.CASH, amountKobo: order.totals.balanceKobo },
        ],
      },
      randomUUID(),
    );

  /** The settings as the Settings screen reads them. */
  const readSettings = async () =>
    (
      (
        await request(server())
          .get('/api/v1/staff/settings')
          .set(as('owner'))
          .expect(200)
      ).body as {
        settings: {
          deliveryJosKobo: number;
          deliveryOutsideKobo: number;
          depositKobo: number;
          freeTableReminderMinutes: number;
          approvalLimitKobo: number;
          version: number;
        };
      }
    ).settings;

  // First, while the seeded settings row is untouched.
  it('settings default to the agreed delivery fees, no deposit and a 3 hour hold', async () => {
    const s = await readSettings();

    expect([
      s.deliveryJosKobo,
      s.deliveryOutsideKobo,
      s.depositKobo,
      s.freeTableReminderMinutes,
    ]).toEqual([500000, 1000000, 0, 180]);
  });

  it('audit snapshots survive later order changes without mutation', async () => {
    const drink = drinks[0];

    await countTo(StockLocation.BAR, drink.stockItemId, 20);

    const id = await barOrder(drink);
    const rows = () =>
      prisma.auditLog.findMany({
        where: { ref: id.number },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      });
    const first = await rows();
    const sentences = async () =>
      (
        (
          await request(server())
            .get('/api/v1/staff/audit')
            .query({ ref: id.number })
            .set(as('owner'))
            .expect(200)
        ).body as { data: { id: string; changes: string[] }[] }
      ).data;
    const firstSentences = await sentences();

    let order = (await quantity('manager', id, drink.menuItemId, 4).expect(200))
      .body as Order;
    order = (await command('manager', order, 'payment').expect(200))
      .body as Order;
    await settle('manager', order).expect(200);

    const later = await rows();

    expect(later.length).toBeGreaterThan(first.length);
    expect(later.slice(0, first.length)).toEqual(first);

    const laterSentences = await sentences();

    for (const entry of firstSentences) {
      expect(laterSentences.find((e) => e.id === entry.id)).toEqual(entry);
    }
  });

  it('staff permissions block kitchen payment and waiter stock adjustments', async () => {
    const drink = drinks[1];

    await countTo(StockLocation.BAR, drink.stockItemId, 10);

    const order = (
      await command('manager', await barOrder(drink), 'payment').expect(200)
    ).body as Order;

    const kitchen = await command(
      'kitchen',
      order,
      'settle',
      { payments: [] },
      randomUUID(),
    ).expect(403);

    expect(messageOf(kitchen)).toBe(ROLE_REFUSED_MESSAGE);

    const waiter = await request(server())
      .post('/api/v1/staff/stock/adjustments')
      .set(as('waiter'))
      .set('Idempotency-Key', randomUUID())
      .send({
        stockItemId: drink.stockItemId,
        location: StockLocation.BAR,
        direction: 'ADD',
        qty: 1,
        reason: 'Test',
      })
      .expect(403);

    expect(messageOf(waiter)).toBe(
      ownerOnlyMessage(OWNER_ONLY_ACTIONS.correctStockBalance),
    );

    // Neither refusal changed anything.
    expect(
      await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true, _count: { select: { payments: true } } },
      }),
    ).toEqual({ status: OrderStatus.PAYMENT, _count: { payments: 0 } });
    expect(await balance(drink.stockItemId, StockLocation.BAR)).toBe(10);
  });

  it('the storekeeper can issue directly to the bar in whole units', async () => {
    const drink = drinks[2];

    await countTo(StockLocation.STORE, drink.stockItemId, 3);
    const store = await balance(drink.stockItemId, StockLocation.STORE);
    const bar = await balance(drink.stockItemId, StockLocation.BAR);

    await request(server())
      .post('/api/v1/staff/stock/issues')
      .set(as('storekeeper'))
      .set('Idempotency-Key', randomUUID())
      .send({
        location: StockLocation.BAR,
        stockItemId: drink.stockItemId,
        qty: 1,
        note: 'Evening rush',
      })
      .expect(201);

    expect(await balance(drink.stockItemId, StockLocation.STORE)).toBe(
      store - 1,
    );
    expect(await balance(drink.stockItemId, StockLocation.BAR)).toBe(
      bar + drink.factor,
    );
    expect(drink.factor).toBe(12);

    // The demo's refusal: the Kitchen issuing its own portion.
    const portion = (
      await request(server())
        .post('/api/v1/staff/stock/items')
        .set(as('manager'))
        .send({
          name: 'Ports portion',
          unit: 'portion',
          pack: 'tray',
          factor: 10,
          minimum: 15,
        })
        .expect(201)
    ).body as { id: string };
    const refused = await request(server())
      .post('/api/v1/staff/stock/issues')
      .set(as('kitchen'))
      .set('Idempotency-Key', randomUUID())
      .send({
        location: StockLocation.KITCHEN,
        stockItemId: portion.id,
        qty: 1,
      })
      .expect(403);

    expect(messageOf(refused)).toBe(ROLE_REFUSED_MESSAGE);
  });

  it('new portions begin at zero; unit changes preserve receiving quantity through a ledger movement', async () => {
    const created = (
      await request(server())
        .post('/api/v1/staff/stock/items')
        .set(as('manager'))
        .send({
          name: 'New test portion',
          pack: 'tray',
          unit: 'portion',
          factor: 10,
          minimum: 5,
        })
        .expect(201)
    ).body as { id: string };

    expect(await balance(created.id, StockLocation.STORE)).toBe(0);

    const drink = drinks[3];

    await countTo(StockLocation.STORE, drink.stockItemId, 7);
    const packs = await balance(drink.stockItemId, StockLocation.STORE);
    const item = await prisma.stockItem.findUniqueOrThrow({
      where: { id: drink.stockItemId },
      select: { version: true },
    });

    await request(server())
      .patch(`/api/v1/staff/stock/items/${drink.stockItemId}`)
      .set(as('manager'))
      .send({
        pack: 'crate',
        unit: 'bottle',
        factor: 24,
        minimum: 12,
        reason: 'Convert packs to crates',
        version: item.version,
      })
      .expect(200);

    expect(await balance(drink.stockItemId, StockLocation.STORE)).toBe(packs);

    const last = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'stockitem.save', ref: drink.stockItemId },
      orderBy: { at: 'desc' },
      select: { before: true, reason: true },
    });

    expect(last.before).toMatchObject({ factor: 12 });
    expect(last.reason).toBe('Convert packs to crates');
  });

  // owner.test.cjs. The order-payments suite ports the first half; the
  // lowered limit needs the settings row, which only a suite with a
  // database of its own may change.
  it('discounts above the limit need the Owner; a lowered limit applies at once', async () => {
    const LIMIT = 5000000;
    const dish = await prisma.menuItem.findFirstOrThrow({
      where: {
        department: Department.RESTAURANT,
        active: true,
        choiceOptions: { isEmpty: true },
      },
      orderBy: [{ priceKobo: 'desc' }, { slug: 'asc' }],
      select: { id: true, priceKobo: true },
    });
    const qty = Math.floor(LIMIT / dish.priceKobo) + 1;

    expect((await readSettings()).approvalLimitKobo).toBe(LIMIT);

    let order = (
      await quantity(
        'manager',
        await open('manager', Department.RESTAURANT),
        dish.id,
        qty,
      ).expect(200)
    ).body as Order & {
      discountKobo: number;
      totals: { subtotalKobo: number };
    };

    expect(order.totals.subtotalKobo).toBeGreaterThan(LIMIT);

    const discount = (actor: Actor, amountKobo: number, reason: string) =>
      command(actor, order, 'discount', { amountKobo, reason });

    order = (await discount('manager', 4000000, 'Staff meal').expect(200))
      .body as typeof order;
    expect(order.discountKobo).toBe(4000000);

    const big = await discount('manager', 5000100, 'Big').expect(403);

    expect(messageOf(big)).toBe(
      approvalLimitMessage(LIMITED_DECISIONS.discount, LIMIT),
    );

    order = (await discount('owner', 5000100, 'Big').expect(200))
      .body as typeof order;
    expect(order.discountKobo).toBe(5000100);

    const settings = await readSettings();

    await request(server())
      .patch('/api/v1/staff/settings')
      .set(as('owner'))
      .send({ approvalLimitKobo: 100000, version: settings.version })
      .expect(200);

    const lowered = await discount('manager', 200000, 'x').expect(403);

    expect(messageOf(lowered)).toBe(
      approvalLimitMessage(LIMITED_DECISIONS.discount, 100000),
    );
    expect(
      (
        await prisma.order.findUniqueOrThrow({
          where: { id: order.id },
          select: { discountKobo: true },
        })
      ).discountKobo,
    ).toBe(5000100);
  });

  it('midnight uses Lagos time and freezes yesterday items while allowing settlement', async () => {
    // The demo's NOW and NEXT, on the next such evening: 23:30 in Jos,
    // then one second past midnight.
    const real = Date.now();
    const at = new Date(real);
    let now = Date.UTC(
      at.getUTCFullYear(),
      at.getUTCMonth(),
      at.getUTCDate(),
      22,
      30,
    );

    while (now <= real) now += 24 * 60 * 60_000;

    const next = now + 30 * 60_000 + 1000;

    expect(formatIsoDate(watToday(new Date(now)))).toBe(
      new Date(now).toISOString().slice(0, 10),
    );
    expect(formatIsoDate(watToday(new Date(next)))).toBe(
      new Date(next + 60 * 60_000).toISOString().slice(0, 10),
    );
    expect(formatIsoDate(watToday(new Date(next)))).not.toBe(
      formatIsoDate(watToday(new Date(now))),
    );

    const drink = drinks[4];

    await countTo(StockLocation.BAR, drink.stockItemId, 10);
    await moveClockTo(now);

    const id = await barOrder(drink);

    expect(id.businessDate).toBe(formatIsoDate(watToday(new Date(now))));

    await moveClockTo(next);

    const frozen = await quantity('manager', id, drink.menuItemId, 1).expect(
      409,
    );

    expect(messageOf(frozen)).toBe(PREVIOUS_DAY_MESSAGE);

    const handedOver = (await command('manager', id, 'payment').expect(200))
      .body as Order;
    const settled = (await settle('manager', handedOver).expect(200))
      .body as Order;

    expect(settled.status).toBe(OrderStatus.SETTLED);
    expect(
      await prisma.stockMovement.findMany({
        where: { ref: id.number },
        select: { type: true, qty: true },
      }),
    ).toEqual([{ type: StockMovementType.BAR_SALE, qty: -2 }]);

    const newId = (
      await request(server())
        .post('/api/v1/staff/orders')
        .set(as('manager'))
        .set('Idempotency-Key', randomUUID())
        .send({
          department: Department.BAR,
          tableId: (
            await prisma.diningTable.findFirstOrThrow({
              where: { code: 'B1', venue: { slug: 'dining' } },
              select: { id: true },
            })
          ).id,
        })
        .expect(201)
    ).body as Order;

    expect(newId.businessDate).toBe(formatIsoDate(watToday(new Date(next))));
  });
});
