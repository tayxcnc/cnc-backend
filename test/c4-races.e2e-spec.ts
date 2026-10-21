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
  TableSessionStatus,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import {
  ALREADY_RESERVED_MESSAGE,
  TABLE_RESERVED_MESSAGE,
  GUESTS_SEATED_MESSAGE,
} from '../src/reception/reception-messages';
import { insufficientStockMessage } from '../src/stock/stock-messages';
import { createTestApp } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * The C4 race tests (card C4-10), through HTTP and against Postgres, with
 * the requests truly in flight together (`Promise.all` over the routes):
 *
 * - two settles on one bill: one 200, one 409 with the refresh sentence,
 *   one payment, and Bar stock moved once, over several bills;
 * - two bookings on one table and date: one booking, the other refused,
 *   whether both are new bookings, a booking against a change, or a
 *   booking against a walk-in seated at the table that day;
 * - concurrent stock movements on one balance: none lost, whatever moves
 *   them (issues, settles, kitchen entries), and a balance that cannot
 *   cover every settle refuses the shortfall and never goes below zero.
 *
 * The suites that own each command keep their own single races (orders,
 * order payments, kitchen, reception, stock); this one repeats the
 * acceptance races several times and adds the races across commands.
 *
 * It runs on a database of its own (`createIsolatedDatabase`) seeded with
 * the real reference data and menu, so the bookings meet the seeded
 * opening hours that no other suite can change under them, and every
 * balance asserted is this suite's alone.
 */
describe('C4 races (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  const originalUrl = process.env.CNC_DB_URL;

  type Actor =
    | 'owner'
    | 'manager'
    | 'cashier'
    | 'cashier2'
    | 'waiter'
    | 'kitchen'
    | 'storekeeper'
    | 'reception';

  const ROLE: Record<Actor, StaffRole> = {
    owner: StaffRole.OWNER,
    manager: StaffRole.MANAGER,
    cashier: StaffRole.CASHIER,
    cashier2: StaffRole.CASHIER,
    waiter: StaffRole.WAITER,
    kitchen: StaffRole.KITCHEN,
    storekeeper: StaffRole.STOREKEEPER,
    reception: StaffRole.RECEPTION,
  };

  const token: Partial<Record<Actor, string>> = {};

  interface Order {
    id: string;
    number: string;
    status: OrderStatus;
    totals: { balanceKobo: number };
    payments: unknown[];
    version: number;
  }

  interface Drink {
    menuItemId: string;
    stockItemId: string;
    name: string;
    factor: number;
  }

  /** Drinks with their seeded Bar stock items, each used by one test only. */
  let drinks: Drink[];
  let dishId: string;
  /** Lounge and Diner tables, each used by one booking test only. */
  let tables: string[];

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    const tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);

    // Only Date is faked, at the next 12:00 in Jos, so no race depends on
    // the wall clock: the booking against a walk-in books today at 23:59,
    // which the real clock refuses as past in the last minute of a day.
    // Tokens are minted after, so they live at the suite's time.
    fakeDateOnly(nextNoonInJos());

    for (const actor of Object.keys(ROLE) as Actor[]) {
      const made = await createStaffAccount(prisma, ROLE[actor], {
        emailPrefix: 'c4-races',
        name: `Races ${actor}`,
      });
      token[actor] = await accessTokenFor(tokens, made.id);
    }

    drinks = (
      await prisma.menuItem.findMany({
        where: {
          department: Department.BAR,
          active: true,
          stockItem: { isNot: null },
        },
        orderBy: { slug: 'asc' },
        take: 6,
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

    dishId = (
      await prisma.menuItem.findFirstOrThrow({
        where: {
          department: Department.RESTAURANT,
          active: true,
          choiceOptions: { isEmpty: true },
        },
        orderBy: { slug: 'asc' },
        select: { id: true },
      })
    ).id;

    tables = (
      await prisma.diningTable.findMany({
        where: { active: true, capacity: { gte: 2 } },
        orderBy: [{ venueId: 'asc' }, { code: 'asc' }],
        select: { id: true },
      })
    ).map((table) => table.id);
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
  const statusesOf = (responses: request.Response[]) =>
    responses.map((response) => response.status).sort();
  const dayFromToday = (days: number) =>
    formatIsoDate(addDays(watToday(new Date()), days));

  /** The Owner records a balance by stock count, as opening balances go in (Q11). */
  async function countTo(
    location: StockLocation,
    stockItemId: string,
    counted: number,
  ): Promise<void> {
    await request(server())
      .post('/api/v1/staff/stock/counts')
      .set(as('owner'))
      .set('Idempotency-Key', randomUUID())
      .send({ location, counts: [{ stockItemId, counted }] })
      .expect(201);
  }

  async function balance(
    stockItemId: string,
    location: StockLocation,
  ): Promise<number> {
    return (
      (
        await prisma.stockBalance.findUnique({
          where: { stockItemId_location: { stockItemId, location } },
          select: { qty: true },
        })
      )?.qty ?? 0
    );
  }

  /** No update lost: the balance is the sum of every movement written. */
  async function expectLedgerHolds(
    stockItemId: string,
    location: StockLocation,
  ): Promise<void> {
    const sum = await prisma.stockMovement.aggregate({
      where: { stockItemId, location },
      _sum: { qty: true },
    });

    expect(await balance(stockItemId, location)).toBe(sum._sum.qty ?? 0);
  }

  const command = (
    actor: Actor,
    order: Pick<Order, 'id' | 'version'>,
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

  /** A bill of `qty` of one dish or drink, handed over for payment. */
  async function billAwaitingPayment(
    department: Department,
    menuItemId: string,
    qty: number,
  ): Promise<Order> {
    const opened = (
      await request(server())
        .post('/api/v1/staff/orders')
        .set(as('cashier'))
        .set('Idempotency-Key', randomUUID())
        .send({ department })
        .expect(201)
    ).body as Order;
    let order = (
      await request(server())
        .put(`/api/v1/staff/orders/${opened.id}/lines`)
        .set(as('cashier'))
        .send({ version: opened.version, menuItemId, qty })
        .expect(200)
    ).body as Order;

    if (department === Department.RESTAURANT) {
      order = (
        (await command('waiter', order, 'confirm').expect(200)).body as {
          order: Order;
        }
      ).order;
    }

    return (await command('cashier', order, 'payment').expect(200))
      .body as Order;
  }

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

  describe('two settles on one bill', () => {
    it('two tills settling one bill at once: one 200, one 409, one payment, stock moved once (five bills)', async () => {
      const drink = drinks[0];
      const ROUNDS = 5;

      await countTo(StockLocation.BAR, drink.stockItemId, 40);

      for (let round = 0; round < ROUNDS; round += 1) {
        const bill = await billAwaitingPayment(
          Department.BAR,
          drink.menuItemId,
          2,
        );
        const results = await Promise.all([
          settle('cashier', bill),
          settle('cashier2', bill),
        ]);

        expect(statusesOf(results)).toEqual([200, 409]);
        expect(messageOf(results.find((r) => r.status === 409)!)).toBe(
          STALE_VERSION_MESSAGE,
        );
        expect(
          await prisma.payment.count({ where: { orderId: bill.id } }),
        ).toBe(1);
        expect(
          await prisma.stockMovement.findMany({
            where: { ref: bill.number },
            select: { type: true, qty: true },
          }),
        ).toEqual([{ type: StockMovementType.BAR_SALE, qty: -2 }]);
        expect(
          (
            await prisma.order.findUniqueOrThrow({
              where: { id: bill.id },
              select: { status: true },
            })
          ).status,
        ).toBe(OrderStatus.SETTLED);
      }

      expect(await balance(drink.stockItemId, StockLocation.BAR)).toBe(
        40 - 2 * ROUNDS,
      );
      await expectLedgerHolds(drink.stockItemId, StockLocation.BAR);
    });

    it('a settle and a part payment on one bill at once: only one is taken', async () => {
      const bill = await billAwaitingPayment(Department.RESTAURANT, dishId, 2);
      const results = await Promise.all([
        settle('cashier', bill),
        command(
          'cashier2',
          bill,
          'part-payments',
          {
            payments: [{ method: PaymentMethod.CARD, amountKobo: 100 }],
          },
          randomUUID(),
        ),
      ]);
      const won = results.filter((r) => r.status < 300);
      const lost = results.filter((r) => r.status === 409);

      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(messageOf(lost[0])).toBe(STALE_VERSION_MESSAGE);

      const after = await prisma.order.findUniqueOrThrow({
        where: { id: bill.id },
        select: { status: true, payments: { select: { part: true } } },
      });

      expect(after.payments).toHaveLength(1);
      expect(after.status).toBe(
        after.payments[0].part ? OrderStatus.PAYMENT : OrderStatus.SETTLED,
      );
    });
  });

  describe('two bookings on one table and date', () => {
    const book = (tableId: string, businessDate: string, time = '19:00') =>
      request(server())
        .post('/api/v1/staff/reservations')
        .set(as('reception'))
        .set('Idempotency-Key', randomUUID())
        .send({
          tableId,
          name: 'Race Guest',
          phone: '08031234567',
          email: 'race@example.com',
          party: 2,
          businessDate,
          time,
        });

    it('two bookings at once: one is made, the other refused (five tables)', async () => {
      const date = dayFromToday(2);

      for (const tableId of tables.slice(0, 5)) {
        const results = await Promise.all([
          book(tableId, date, '19:00'),
          book(tableId, date, '20:30'),
        ]);

        expect(statusesOf(results)).toEqual([201, 409]);
        expect(messageOf(results.find((r) => r.status === 409)!)).toBe(
          ALREADY_RESERVED_MESSAGE,
        );
        expect(
          await prisma.reservation.count({
            where: { tableId, businessDate: new Date(`${date}T00:00:00Z`) },
          }),
        ).toBe(1);
      }
    });

    it('a new booking and a change onto the same table and date at once: one wins', async () => {
      const [target, other] = tables.slice(5, 7);
      const date = dayFromToday(3);
      const moving = (await book(other, date).expect(201)).body as {
        id: string;
        version: number;
      };

      const results = await Promise.all([
        book(target, date),
        request(server())
          .patch(`/api/v1/staff/reservations/${moving.id}`)
          .set(as('reception'))
          .send({ version: moving.version, tableId: target }),
      ]);
      const won = results.filter((r) => r.status < 300);
      const lost = results.filter((r) => r.status === 409);

      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(messageOf(lost[0])).toBe(ALREADY_RESERVED_MESSAGE);
      expect(
        await prisma.reservation.count({
          where: {
            tableId: target,
            businessDate: new Date(`${date}T00:00:00Z`),
          },
        }),
      ).toBe(1);
    });

    it('a booking for today and a walk-in seated at the table at once: the table holds one of them', async () => {
      const tableId = tables[7];
      const results = await Promise.all([
        book(tableId, dayFromToday(0), '23:59'),
        request(server())
          .post(`/api/v1/staff/tables/${tableId}/allocate`)
          .set(as('reception'))
          .send({
            status: TableSessionStatus.OCCUPIED,
            guest: 'Walk-in',
            party: 2,
          }),
      ]);
      const [booking, seating] = results;

      expect(statusesOf(results)).toEqual([201, 409]);

      if (booking.status === 201) {
        expect(messageOf(seating)).toBe(TABLE_RESERVED_MESSAGE);
      } else {
        expect(messageOf(booking)).toBe(GUESTS_SEATED_MESSAGE);
      }

      const bookings = await prisma.reservation.count({ where: { tableId } });
      const seatings = await prisma.tableSession.count({
        where: { tableId, endedAt: null },
      });

      expect(bookings + seatings).toBe(1);
    });
  });

  describe('concurrent stock movements lose no update', () => {
    it('ten issues of one item at once: every pack leaves the Store once and arrives once', async () => {
      const drink = drinks[1];
      const ISSUES = 10;

      await countTo(StockLocation.STORE, drink.stockItemId, ISSUES);
      const barBefore = await balance(drink.stockItemId, StockLocation.BAR);

      const results = await Promise.all(
        Array.from({ length: ISSUES }, () =>
          request(server())
            .post('/api/v1/staff/stock/issues')
            .set(as('storekeeper'))
            .set('Idempotency-Key', randomUUID())
            .send({
              location: StockLocation.BAR,
              stockItemId: drink.stockItemId,
              qty: 1,
            }),
        ),
      );

      expect(statusesOf(results)).toEqual(Array(ISSUES).fill(201));
      expect(await balance(drink.stockItemId, StockLocation.STORE)).toBe(0);
      expect(await balance(drink.stockItemId, StockLocation.BAR)).toBe(
        barBefore + ISSUES * drink.factor,
      );
      await expectLedgerHolds(drink.stockItemId, StockLocation.STORE);
      await expectLedgerHolds(drink.stockItemId, StockLocation.BAR);
    });

    it('settles and issues on one Bar balance at once: every movement lands', async () => {
      const drink = drinks[2];
      const SETTLES = 6;
      const ISSUES = 4;
      const OPENING = 30;

      await countTo(StockLocation.BAR, drink.stockItemId, OPENING);
      await countTo(StockLocation.STORE, drink.stockItemId, ISSUES);

      const bills = await Promise.all(
        Array.from({ length: SETTLES }, () =>
          billAwaitingPayment(Department.BAR, drink.menuItemId, 1),
        ),
      );
      const results = await Promise.all([
        ...bills.map((bill, i) =>
          settle(i % 2 === 0 ? 'cashier' : 'cashier2', bill),
        ),
        ...Array.from({ length: ISSUES }, () =>
          request(server())
            .post('/api/v1/staff/stock/issues')
            .set(as('storekeeper'))
            .set('Idempotency-Key', randomUUID())
            .send({
              location: StockLocation.BAR,
              stockItemId: drink.stockItemId,
              qty: 1,
            }),
        ),
      ]);

      expect(results.slice(0, SETTLES).map((r) => r.status)).toEqual(
        Array(SETTLES).fill(200),
      );
      expect(results.slice(SETTLES).map((r) => r.status)).toEqual(
        Array(ISSUES).fill(201),
      );
      expect(await balance(drink.stockItemId, StockLocation.BAR)).toBe(
        OPENING - SETTLES + ISSUES * drink.factor,
      );
      expect(await balance(drink.stockItemId, StockLocation.STORE)).toBe(0);
      await expectLedgerHolds(drink.stockItemId, StockLocation.BAR);
    });

    it('more settles than the Bar can cover: the shortfall is refused and the balance never goes below zero', async () => {
      const drink = drinks[3];
      const BILLS = 6;
      const ON_HAND = 3;

      await countTo(StockLocation.BAR, drink.stockItemId, ON_HAND);

      const bills = await Promise.all(
        Array.from({ length: BILLS }, () =>
          billAwaitingPayment(Department.BAR, drink.menuItemId, 1),
        ),
      );
      const results = await Promise.all(
        bills.map((bill, i) =>
          settle(i % 2 === 0 ? 'cashier' : 'cashier2', bill),
        ),
      );
      const refused = results.filter((r) => r.status === 409);

      expect(results.filter((r) => r.status === 200)).toHaveLength(ON_HAND);
      expect(refused).toHaveLength(BILLS - ON_HAND);
      for (const response of refused) {
        expect(messageOf(response)).toBe(
          insufficientStockMessage(StockLocation.BAR, drink.name),
        );
      }
      expect(await balance(drink.stockItemId, StockLocation.BAR)).toBe(0);
      await expectLedgerHolds(drink.stockItemId, StockLocation.BAR);

      // A refused settle took no money and left its bill awaiting payment.
      const unpaid = await prisma.order.findMany({
        where: {
          id: { in: bills.map((b) => b.id) },
          status: OrderStatus.PAYMENT,
        },
        select: { _count: { select: { payments: true } } },
      });

      expect(unpaid).toHaveLength(BILLS - ON_HAND);
      expect(unpaid.every((bill) => bill._count.payments === 0)).toBe(true);
    });

    it('kitchen entries for several dockets sharing a portion at once: every portion is taken once', async () => {
      const portion = (
        await request(server())
          .post('/api/v1/staff/stock/items')
          .set(as('manager'))
          .send({
            name: 'Race portion',
            unit: 'portion',
            pack: 'tray',
            factor: 10,
            minimum: 5,
          })
          .expect(201)
      ).body as { id: string };
      const DOCKETS = 5;
      const EACH = 2;

      await countTo(StockLocation.KITCHEN, portion.id, 20);

      const refs: string[] = [];

      for (let i = 0; i < DOCKETS; i += 1) {
        const bill = await billAwaitingPayment(
          Department.RESTAURANT,
          dishId,
          1,
        );
        refs.push(`KOT-${bill.number}`);
      }

      const results = await Promise.all(
        refs.map((ref) =>
          request(server())
            .put(`/api/v1/staff/kitchen/entries/${ref}`)
            .set(as('kitchen'))
            .send({ lines: [{ stockItemId: portion.id, qty: EACH }] }),
        ),
      );

      expect(statusesOf(results)).toEqual(Array(DOCKETS).fill(200));
      expect(await balance(portion.id, StockLocation.KITCHEN)).toBe(
        20 - DOCKETS * EACH,
      );
      await expectLedgerHolds(portion.id, StockLocation.KITCHEN);
    });
  });
});
