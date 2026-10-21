import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  OrderStatus,
  PaymentMethod,
  ReservationStatus,
  StaffRole,
  StockLocation,
  StockMovementType,
  TableSessionStatus,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { CrosscheckStatus } from '../src/kitchen/kitchen-crosscheck';
import {
  OWNER_ONLY_ACTIONS,
  ownerOnlyMessage,
} from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { ALREADY_RESERVED_MESSAGE } from '../src/reception/reception-messages';
import { createTestApp } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * The founder's C4 gate (plan §15, C4), steps 1 to 11, walked against the
 * API in order, as the staff app will drive it (card C4-9's e2e walk).
 *
 * It runs on a database of its own (`createIsolatedDatabase`) seeded with
 * the real reference data and menu (`seedData`), so the tables are the
 * venue's own (Diner B1, Lounge TS1), the dish with a choice is a real
 * dish, and the drink is a real drink with its seeded Bar stock item. No
 * Kitchen item is seeded: step 1 makes one, as a manager would.
 *
 * **The clock is controlled.** Jest's fake `Date` (and only `Date`: every
 * timer stays real, so Postgres, the HTTP server and the pool run as
 * usual) starts the walk at the next 12:00 in Jos and moves forward as the
 * steps need: to tomorrow evening for the check-in of a booking made for
 * tomorrow, and on past the Free Table Reminder's 180 minutes. The server
 * reads the time through `new Date()` everywhere a rule depends on it, so
 * it sees the same clock. The clock only ever moves forward, so every row
 * Postgres stamps with its own `now()` still sorts in the order written.
 * An access token lives 15 minutes, so each jump mints fresh ones.
 *
 * The steps share state and must run in order; each is one test so a
 * failure names its step. Jest runs a file's tests in order.
 */
describe('the C4 gate (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  const originalUrl = process.env.CNC_DB_URL;

  const MINUTE = 60_000;

  type Actor =
    | 'owner'
    | 'manager'
    | 'waiter'
    | 'kitchen'
    | 'cashier'
    | 'cashier2'
    | 'bartender'
    | 'reception';

  const ROLE: Record<Actor, StaffRole> = {
    owner: StaffRole.OWNER,
    manager: StaffRole.MANAGER,
    waiter: StaffRole.WAITER,
    kitchen: StaffRole.KITCHEN,
    cashier: StaffRole.CASHIER,
    cashier2: StaffRole.CASHIER,
    bartender: StaffRole.BARTENDER,
    reception: StaffRole.RECEPTION,
  };

  const staffId: Partial<Record<Actor, string>> = {};
  const token: Partial<Record<Actor, string>> = {};

  interface Line {
    menuItemId: string;
    option: string;
    qty: number;
    unitPriceKobo: number;
  }

  interface Docket {
    ref: string;
    orderNumber: string;
    revision: number;
    businessDate: string;
    items: Line[];
  }

  interface Payment {
    number: string;
    method: PaymentMethod;
    amountKobo: number;
    reference: string;
    part: boolean;
    reversed: boolean;
  }

  interface Order {
    id: string;
    number: string;
    department: Department;
    status: OrderStatus;
    label: string;
    table: { code: string; venueName: string } | null;
    businessDate: string;
    lines: Line[];
    totals: { totalKobo: number; paidKobo: number; balanceKobo: number };
    payments: Payment[];
    latestDocket: Docket | null;
    version: number;
  }

  interface Session {
    id: string;
    status: TableSessionStatus;
    guest: string;
    reminderDue: boolean;
    endedAt: string | null;
    version: number;
  }

  interface Booking {
    id: string;
    number: string;
    tableRef: string;
    businessDate: string;
    status: ReservationStatus;
    version: number;
  }

  interface FloorTable {
    id: string;
    ref: string;
    status: string;
    session: Session | null;
  }

  // Found in the seeded data in beforeAll.
  let dinerB1: string;
  let loungeTs1: string;
  let dish: { id: string; slug: string; option: string; priceKobo: number };
  let drink: { id: string; stockItemId: string; priceKobo: number };
  /** Step 1's Kitchen portion. */
  let portionId: string;

  // Carried from step to step.
  let foodBill: Order;
  let docketRef: string;
  let barBill: Order;
  let booking: Booking;
  let seated: Session;

  const KITCHEN_OPENING = 20;
  const STORE_OPENING = 5;
  const BAR_OPENING = 24;

  /** Fresh access tokens for everyone, minted at the clock's time. */
  async function mintTokens(): Promise<void> {
    for (const actor of Object.keys(ROLE) as Actor[]) {
      token[actor] = await accessTokenFor(tokens, staffId[actor]!);
    }
  }

  /** Move the clock forward to `at` and mint tokens that live there. */
  async function moveClockTo(at: number): Promise<void> {
    if (at <= Date.now()) throw new Error('The gate clock only moves forward.');

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
          emailPrefix: 'c4-gate',
          name: `Gate ${actor}`,
        })
      ).id;
    }

    const table = async (venueSlug: string, code: string) =>
      (
        await prisma.diningTable.findFirstOrThrow({
          where: { code, venue: { slug: venueSlug } },
          select: { id: true },
        })
      ).id;

    dinerB1 = await table('dining', 'B1');
    loungeTs1 = await table('lounge', 'TS1');

    const withChoice = await prisma.menuItem.findFirstOrThrow({
      where: {
        department: Department.RESTAURANT,
        active: true,
        NOT: { choiceOptions: { isEmpty: true } },
      },
      orderBy: { slug: 'asc' },
      select: { id: true, slug: true, choiceOptions: true, priceKobo: true },
    });
    dish = {
      id: withChoice.id,
      slug: withChoice.slug,
      option: withChoice.choiceOptions[0],
      priceKobo: withChoice.priceKobo,
    };

    const paired = await prisma.menuItem.findFirstOrThrow({
      where: {
        department: Department.BAR,
        active: true,
        stockItem: { isNot: null },
      },
      orderBy: { slug: 'asc' },
      select: {
        id: true,
        priceKobo: true,
        stockItem: { select: { id: true } },
      },
    });
    drink = {
      id: paired.id,
      stockItemId: paired.stockItem!.id,
      priceKobo: paired.priceKobo,
    };

    // Only Date is faked; every timer stays real (see the suite's comment).
    // The walk's first instant is the next 12:00 in Jos.
    fakeDateOnly(nextNoonInJos());
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
  const today = () => formatIsoDate(watToday(new Date()));
  const tomorrow = () => formatIsoDate(addDays(watToday(new Date()), 1));

  const count = (
    location: StockLocation,
    stockItemId: string,
    counted: number,
  ) =>
    request(server())
      .post('/api/v1/staff/stock/counts')
      .set(as('owner'))
      .set('Idempotency-Key', randomUUID())
      .send({ location, counts: [{ stockItemId, counted }] });

  async function balance(
    stockItemId: string,
    location: StockLocation,
  ): Promise<number> {
    const response = await request(server())
      .get('/api/v1/staff/stock/balances')
      .query({ location, pageSize: 100 })
      .set(as('manager'))
      .expect(200);
    const row = (
      response.body as { data: { stockItemId: string; qty: number }[] }
    ).data.find((b) => b.stockItemId === stockItemId);

    return row?.qty ?? 0;
  }

  const open = async (actor: Actor, body: Record<string, unknown>) =>
    (
      await request(server())
        .post('/api/v1/staff/orders')
        .set(as(actor))
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(201)
    ).body as Order;

  const setLine = async (
    actor: Actor,
    order: Order,
    line: Record<string, unknown>,
  ) =>
    (
      await request(server())
        .put(`/api/v1/staff/orders/${order.id}/lines`)
        .set(as(actor))
        .send({ version: order.version, ...line })
        .expect(200)
    ).body as Order;

  const read = async (actor: Actor, order: { id: string }) =>
    (
      await request(server())
        .get(`/api/v1/staff/orders/${order.id}`)
        .set(as(actor))
        .expect(200)
    ).body as Order;

  /** POST one of a bill's commands with its version. */
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

  const print = (actor: Actor, body: Record<string, unknown>) =>
    request(server())
      .post('/api/v1/staff/audit/print')
      .set(as(actor))
      .send(body);

  async function history(actor: Actor, ref: string) {
    const response = await request(server())
      .get('/api/v1/staff/audit')
      .query({ ref })
      .set(as(actor))
      .expect(200);

    return (response.body as { data: { action: string }[] }).data;
  }

  async function lounge(): Promise<FloorTable> {
    const response = await request(server())
      .get('/api/v1/staff/floor')
      .query({ venue: 'lounge' })
      .set(as('reception'))
      .expect(200);

    return (response.body as { tables: FloorTable[] }).tables.find(
      (t) => t.id === loungeTs1,
    )!;
  }

  async function bell(actor: Actor) {
    const response = await request(server())
      .get('/api/v1/staff/notifications')
      .query({ pageSize: 100 })
      .set(as(actor))
      .expect(200);

    return (
      response.body as { data: { id: string; title: string; detail: string }[] }
    ).data.filter((item) => item.id.startsWith(`free:${loungeTs1}:`));
  }

  it('1. the Owner records opening balances by stock count, and sets a comparison rule', async () => {
    const item = await request(server())
      .post('/api/v1/staff/stock/items')
      .set(as('owner'))
      .send({
        name: 'Gate portion',
        unit: 'portion',
        pack: 'tray',
        factor: 10,
        minimum: 5,
      })
      .expect(201);
    portionId = (item.body as { id: string }).id;

    // A Store and a Kitchen balance for the portion, a Bar balance for the drink.
    for (const [location, stockItemId, counted] of [
      [StockLocation.STORE, portionId, STORE_OPENING],
      [StockLocation.KITCHEN, portionId, KITCHEN_OPENING],
      [StockLocation.BAR, drink.stockItemId, BAR_OPENING],
    ] as const) {
      const response = await count(location, stockItemId, counted).expect(201);

      expect(
        (response.body as { changes: { difference: number }[] }).changes,
      ).toEqual([
        expect.objectContaining({ recorded: 0, counted, difference: counted }),
      ]);
    }

    expect(await balance(portionId, StockLocation.STORE)).toBe(STORE_OPENING);
    expect(await balance(portionId, StockLocation.KITCHEN)).toBe(
      KITCHEN_OPENING,
    );
    expect(await balance(drink.stockItemId, StockLocation.BAR)).toBe(
      BAR_OPENING,
    );
    expect(
      await prisma.stockMovement.count({
        where: { type: StockMovementType.STOCK_COUNT },
      }),
    ).toBe(3);

    // One comparison rule: one portion per plate of the step 2 dish.
    const rule = await request(server())
      .put(`/api/v1/staff/kitchen-mappings/${dish.id}`)
      .set(as('owner'))
      .send({ lines: [{ stockItemId: portionId, qty: 1 }] })
      .expect(200);

    expect(rule.body).toMatchObject({
      menuItemId: dish.id,
      menuItemSlug: dish.slug,
      lines: [
        { stockItemId: portionId, stockItemName: 'Gate portion', qty: 1 },
      ],
    });
  });

  it('2. a waiter opens a Restaurant order on Diner B1, adds a dish with a choice, confirms, and the docket prints', async () => {
    const opened = await open('waiter', {
      department: Department.RESTAURANT,
      tableId: dinerB1,
    });

    expect(opened).toMatchObject({
      department: Department.RESTAURANT,
      status: OrderStatus.OPEN,
      label: 'Booth 1',
      table: { code: 'B1', venueName: 'Diner' },
      businessDate: today(),
    });
    expect(opened.number).toMatch(/^CNCR-\d+$/);

    const withDish = await setLine('waiter', opened, {
      menuItemId: dish.id,
      option: dish.option,
      qty: 2,
    });

    expect(withDish.lines).toEqual([
      expect.objectContaining({
        menuItemId: dish.id,
        option: dish.option,
        qty: 2,
        unitPriceKobo: dish.priceKobo,
      }),
    ]);

    const confirmed = await command('waiter', withDish, 'confirm').expect(200);
    const { reprint, docket, order } = confirmed.body as {
      reprint: boolean;
      docket: Docket;
      order: Order;
    };

    expect(reprint).toBe(false);
    expect(docket).toMatchObject({
      ref: `KOT-${opened.number}`,
      orderNumber: opened.number,
      revision: 1,
      businessDate: today(),
      items: [
        expect.objectContaining({
          menuItemId: dish.id,
          option: dish.option,
          qty: 2,
        }),
      ],
    });
    foodBill = order;
    docketRef = docket.ref;

    // The docket prints in the browser from the API's data, and is recorded.
    const printed = await request(server())
      .get(`/api/v1/staff/dockets/${docketRef}`)
      .set(as('waiter'))
      .expect(200);

    expect((printed.body as Docket).revision).toBe(1);
    await print('waiter', {
      document: 'docket',
      ref: docketRef,
      revision: 1,
    }).expect(204);
    expect((await history('waiter', docketRef)).map((e) => e.action)).toContain(
      'print',
    );
  });

  it('3. the kitchen records portions against the docket number; the crosscheck shows Matched', async () => {
    // Typed from the paper docket, in lower case.
    const saved = await request(server())
      .put(
        `/api/v1/staff/kitchen/entries/${encodeURIComponent(docketRef.toLowerCase())}`,
      )
      .set(as('kitchen'))
      .send({ lines: [{ stockItemId: portionId, qty: 2 }] })
      .expect(200);

    expect(saved.body).toMatchObject({
      docketRef,
      orderNumber: foodBill.number,
      revision: 1,
      businessDate: today(),
    });
    expect(await balance(portionId, StockLocation.KITCHEN)).toBe(
      KITCHEN_OPENING - 2,
    );

    const report = await request(server())
      .get('/api/v1/staff/reports/kitchen-crosscheck')
      .set(as('manager'))
      .expect(200);
    const row = (
      report.body as { data: { ref: string; status: string }[] }
    ).data.find((r) => r.ref === docketRef);

    expect(row?.status).toBe(CrosscheckStatus.MATCHED);
  });

  it('4. the cashier takes a part payment, then settles', async () => {
    const handedOver = await command('waiter', foodBill, 'payment').expect(200);
    let bill = handedOver.body as Order;

    expect(bill.status).toBe(OrderStatus.PAYMENT);

    const total = bill.totals.totalKobo;
    const part = Math.floor(total / 3);

    bill = (
      await command(
        'cashier',
        bill,
        'part-payments',
        {
          payments: [
            {
              method: PaymentMethod.CARD,
              amountKobo: part,
              reference: 'POS 1',
            },
          ],
        },
        randomUUID(),
      ).expect(201)
    ).body as Order;

    expect(bill.status).toBe(OrderStatus.PAYMENT);
    expect(bill.totals).toMatchObject({
      paidKobo: part,
      balanceKobo: total - part,
    });

    bill = (
      await command(
        'cashier',
        bill,
        'settle',
        {
          payments: [{ method: PaymentMethod.CASH, amountKobo: total - part }],
        },
        randomUUID(),
      ).expect(200)
    ).body as Order;

    expect(bill.status).toBe(OrderStatus.SETTLED);
    expect(bill.totals).toMatchObject({ paidKobo: total, balanceKobo: 0 });
    foodBill = bill;
  });

  it('5. the receipt prints both payments', async () => {
    const receipt = await read('cashier', foodBill);
    const total = receipt.totals.totalKobo;

    expect(receipt.payments).toHaveLength(2);
    expect(receipt.payments).toEqual([
      expect.objectContaining({
        method: PaymentMethod.CARD,
        reference: 'POS 1',
        part: true,
        reversed: false,
      }),
      expect.objectContaining({
        method: PaymentMethod.CASH,
        part: false,
        reversed: false,
      }),
    ]);
    expect(
      receipt.payments.reduce((sum, payment) => sum + payment.amountKobo, 0),
    ).toBe(total);
    expect(receipt.lines).toEqual([
      expect.objectContaining({ option: dish.option, qty: 2 }),
    ]);

    // The business lines a receipt prints come with the shell's reference.
    const reference = await request(server())
      .get('/api/v1/staff/reference')
      .set(as('cashier'))
      .expect(200);
    const business = (
      reference.body as {
        business: { name: string; addressLine: string; phone: string };
      }
    ).business;

    expect(business.name).not.toBe('');
    expect(business.addressLine).not.toBe('');
    expect(business.phone).not.toBe('');

    await print('cashier', {
      document: 'receipt',
      ref: foodBill.number,
    }).expect(204);
    expect(
      (await history('cashier', foodBill.number)).map((e) => e.action),
    ).toEqual(
      expect.arrayContaining(['order.partPay', 'order.settle', 'print']),
    );
  });

  it('6. two cashiers press Settle on the same bill at once: one succeeds, the other sees the refresh message', async () => {
    const opened = await open('waiter', {
      department: Department.RESTAURANT,
      tableId: dinerB1,
    });
    const withDish = await setLine('waiter', opened, {
      menuItemId: dish.id,
      option: dish.option,
      qty: 1,
    });
    const sent = (
      (await command('waiter', withDish, 'confirm').expect(200)).body as {
        order: Order;
      }
    ).order;
    const bill = (await command('waiter', sent, 'payment').expect(200))
      .body as Order;
    const payments = [
      { method: PaymentMethod.CASH, amountKobo: bill.totals.balanceKobo },
    ];

    const results = await Promise.all(
      (['cashier', 'cashier2'] as const).map((actor) =>
        command(actor, bill, 'settle', { payments }, randomUUID()),
      ),
    );
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([200, 409]);
    expect(messageOf(results.find((r) => r.status === 409)!)).toBe(
      STALE_VERSION_MESSAGE,
    );

    const after = await read('cashier', bill);

    expect(after.status).toBe(OrderStatus.SETTLED);
    expect(after.payments).toHaveLength(1);
  });

  it('7. a Bar order deducts bar stock once', async () => {
    const opened = await open('bartender', { department: Department.BAR });

    expect(opened.number).toMatch(/^CNCB-\d+$/);

    let bill = await setLine('bartender', opened, {
      menuItemId: drink.id,
      qty: 2,
    });
    bill = await setLine('bartender', bill, { menuItemId: drink.id, qty: 3 });
    bill = (await command('bartender', bill, 'payment').expect(200))
      .body as Order;

    // Neither the edits nor the handoff touched the Bar.
    expect(await balance(drink.stockItemId, StockLocation.BAR)).toBe(
      BAR_OPENING,
    );

    bill = (
      await command(
        'bartender',
        bill,
        'settle',
        {
          payments: [
            { method: PaymentMethod.CASH, amountKobo: bill.totals.balanceKobo },
          ],
        },
        randomUUID(),
      ).expect(200)
    ).body as Order;

    expect(bill.status).toBe(OrderStatus.SETTLED);
    expect(await balance(drink.stockItemId, StockLocation.BAR)).toBe(
      BAR_OPENING - 3,
    );

    const movements = await prisma.stockMovement.findMany({
      where: { ref: bill.number },
      select: { type: true, qty: true, location: true },
    });

    expect(movements).toEqual([
      {
        type: StockMovementType.BAR_SALE,
        qty: -3,
        location: StockLocation.BAR,
      },
    ]);
    barBill = bill;
  });

  it('8. the Owner reverses it and the stock returns', async () => {
    const refused = await command('manager', barBill, 'reverse', {
      reason: 'Wrong bill',
    }).expect(403);

    expect(messageOf(refused)).toBe(
      ownerOnlyMessage(OWNER_ONLY_ACTIONS.reverseBill),
    );

    const reversed = (
      await command('owner', barBill, 'reverse', {
        reason: 'Settled on the wrong bill',
      }).expect(200)
    ).body as Order;

    expect(reversed.status).toBe(OrderStatus.PAYMENT);
    expect(reversed.payments.every((payment) => payment.reversed)).toBe(true);
    expect(await balance(drink.stockItemId, StockLocation.BAR)).toBe(
      BAR_OPENING,
    );
    expect(
      (
        await prisma.stockMovement.findMany({
          where: { ref: barBill.number },
          orderBy: { createdAt: 'asc' },
          select: { type: true, qty: true },
        })
      ).map((m) => [m.type, m.qty]),
    ).toEqual([
      [StockMovementType.BAR_SALE, -3],
      [StockMovementType.SETTLEMENT_REVERSAL, 3],
    ]);
  });

  it('9. Reception books Lounge TS1 for tomorrow; a second booking for the same table and date is refused', async () => {
    const book = (name: string, time: string) =>
      request(server())
        .post('/api/v1/staff/reservations')
        .set(as('reception'))
        .set('Idempotency-Key', randomUUID())
        .send({
          tableId: loungeTs1,
          name,
          phone: '08031234567',
          email: 'gate.guest@example.com',
          party: 2,
          businessDate: tomorrow(),
          time,
        });

    booking = (await book('Gate Guest', '19:00').expect(201)).body as Booking;

    expect(booking).toMatchObject({
      tableRef: 'L-TS1',
      businessDate: tomorrow(),
      status: ReservationStatus.CONFIRMED,
    });

    const second = await book('Second Guest', '21:00').expect(409);

    expect(messageOf(second)).toBe(ALREADY_RESERVED_MESSAGE);
    expect(
      await prisma.reservation.count({ where: { tableId: loungeTs1 } }),
    ).toBe(1);
  });

  it('10. check-in, release', async () => {
    // Tomorrow evening, when the guests arrive.
    const arrival = Date.parse(`${booking.businessDate}T18:55:00.000Z`);

    await moveClockTo(arrival);
    expect(today()).toBe(booking.businessDate);

    const checkedIn = await request(server())
      .post(`/api/v1/staff/reservations/${booking.id}/check-in`)
      .set(as('reception'))
      .send({ version: booking.version })
      .expect(200);
    const { reservation, session } = checkedIn.body as {
      reservation: Booking;
      session: Session;
    };

    expect(reservation.status).toBe(ReservationStatus.CHECKED_IN);
    expect(session).toMatchObject({
      status: TableSessionStatus.OCCUPIED,
      guest: 'Gate Guest',
      reminderDue: false,
    });
    expect(await lounge()).toMatchObject({
      ref: 'L-TS1',
      status: 'OCCUPIED',
      session: { id: session.id },
    });

    const released = await request(server())
      .post(`/api/v1/staff/tables/${loungeTs1}/release`)
      .set(as('reception'))
      .send({ sessionId: session.id, version: session.version })
      .expect(200);

    expect(released.body).toMatchObject({
      completedReservations: [booking.number],
    });
    expect(await lounge()).toMatchObject({
      status: 'AVAILABLE',
      session: null,
    });
    expect(
      (
        await prisma.reservation.findUniqueOrThrow({
          where: { id: booking.id },
          select: { status: true },
        })
      ).status,
    ).toBe(ReservationStatus.COMPLETED);
  });

  it('11. the Free Table Reminder appears after the set time', async () => {
    seated = (
      await request(server())
        .post(`/api/v1/staff/tables/${loungeTs1}/allocate`)
        .set(as('reception'))
        .send({
          status: TableSessionStatus.OCCUPIED,
          guest: 'Walk-in',
          party: 2,
        })
        .expect(201)
    ).body as Session;
    const seatedAt = Date.now();

    expect(await bell('reception')).toEqual([]);

    // The reminder is 180 minutes by default (the seeded settings).
    await moveClockTo(seatedAt + 179 * MINUTE);
    expect(await bell('reception')).toEqual([]);
    expect((await lounge()).session?.reminderDue).toBe(false);

    await moveClockTo(seatedAt + 181 * MINUTE);

    const items = await bell('reception');

    expect(items).toEqual([
      expect.objectContaining({
        title: 'Free Table Reminder',
        detail:
          'Lounge table 1 · Walk-in seated 3 hours ago. Free it if they have left.',
      }),
    ]);
    expect(await bell('manager')).toHaveLength(1);
    expect(await bell('waiter')).toEqual([]);
    expect((await lounge()).session?.reminderDue).toBe(true);

    // Freeing the table answers it.
    await request(server())
      .post(`/api/v1/staff/tables/${loungeTs1}/release`)
      .set(as('reception'))
      .send({ sessionId: seated.id, version: seated.version })
      .expect(200);
    expect(await bell('reception')).toEqual([]);
  });
});
