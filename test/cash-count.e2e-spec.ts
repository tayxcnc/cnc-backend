import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  MenuCategoryKind,
  PaymentMethod,
  StaffRole,
} from '../generated/cnc-client';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import {
  CASH_COUNT_MESSAGE,
  CASH_DATE_MESSAGE,
  CASH_FUTURE_MESSAGE,
} from '../src/cash/cash-messages';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { IDEMPOTENCY_KEY_REQUIRED } from '../src/idempotency/idempotency-key.decorator';
import { IDEMPOTENCY_KEY_REUSED } from '../src/idempotency/idempotency.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';
import { createTestApp } from './create-test-app';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * The cash count (C4-8) through HTTP and against Postgres: `cash.count`,
 * its figures (expected = the date's non-reversed cash payments), who may
 * record it, its audit row, its Idempotency-Key, and the Cash
 * Reconciliation report.
 *
 * It runs on a database of its own (`createIsolatedDatabase`): the
 * expected figure is every cash payment of a date, and on the shared test
 * database the other suites take cash all day, so no figure could be
 * pinned. One bill is settled in cash through the routes; the payments a
 * till cannot make in one step (a reversed one, a cash refund, yesterday's
 * cash) are written directly.
 */
describe('Cash count (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  const token: Partial<Record<StaffRole, string>> = {};
  const staffId: Partial<Record<StaffRole, string>> = {};
  const staffName: Partial<Record<StaffRole, string>> = {};

  let dishId: string;
  let orderId: string;

  const DISH_PRICE = 500000;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    const tokens = app.get(CncTokenService, { strict: false });

    // VAT and service at zero, so the bill's total is the dish's price.
    await prisma.settings.createMany({
      data: [{ vatBps: 0, serviceBps: 0 }],
      skipDuplicates: true,
    });

    for (const role of [
      StaffRole.OWNER,
      StaffRole.MANAGER,
      StaffRole.CASHIER,
      StaffRole.WAITER,
      StaffRole.BARTENDER,
      StaffRole.KITCHEN,
      StaffRole.RECEPTION,
      StaffRole.STOREKEEPER,
    ]) {
      const made = await createStaffAccount(prisma, role, {
        emailPrefix: 'cash',
        name: `Cash suite ${role.toLowerCase()}`,
      });
      token[role] = await accessTokenFor(tokens, made.id);
      staffId[role] = made.id;
      staffName[role] = made.name;
    }

    const menuCategory = await prisma.menuCategory.create({
      data: {
        slug: 'cash-food',
        title: 'Cash food',
        kind: MenuCategoryKind.FOOD,
        sort: 1,
      },
    });
    const staffCategory = await prisma.staffCategory.create({
      data: {
        name: 'Cash food',
        department: Department.RESTAURANT,
        menuCategoryId: menuCategory.id,
      },
    });
    dishId = (
      await prisma.menuItem.create({
        data: {
          slug: 'cash-jollof',
          department: Department.RESTAURANT,
          menuCategoryId: menuCategory.id,
          staffCategoryId: staffCategory.id,
          name: 'Jollof Rice',
          priceKobo: DISH_PRICE,
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const auth = (role: StaffRole) => ({
    Authorization: `Bearer ${token[role]}`,
  });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;
  const sentencesOf = (response: request.Response) =>
    [messageOf(response)].flat();
  const today = () => formatIsoDate(watToday(new Date()));
  const yesterday = () => formatIsoDate(addDays(watToday(new Date()), -1));
  const tomorrow = () => formatIsoDate(addDays(watToday(new Date()), 1));

  interface CashCount {
    id: string;
    number: string;
    businessDate: string;
    staffId: string;
    staffName: string;
    expectedKobo: number;
    countedKobo: number;
    differenceKobo: number;
  }

  interface Report {
    data: CashCount[];
    total: number;
    from: string;
    to: string;
    cashReceivedKobo: number;
    latestDifferenceKobo: number;
  }

  interface Bill {
    id: string;
    version: number;
    totals: { balanceKobo: number };
  }

  const count = (
    role: StaffRole,
    body: Record<string, unknown>,
    key: string | null = randomUUID(),
  ) => {
    const call = request(server())
      .post('/api/v1/staff/cash-counts')
      .set(auth(role));

    if (key !== null) call.set('Idempotency-Key', key);

    return call.send(body);
  };

  /** A payment written directly, against the suite's one bill. */
  const payment = async (
    amountKobo: number,
    method: PaymentMethod,
    businessDate: string,
    reversed = false,
  ) =>
    prisma.payment.create({
      data: {
        number: await drawNumber(prisma, 'payment'),
        orderId,
        method,
        amountKobo,
        businessDate: new Date(`${businessDate}T00:00:00.000Z`),
        reversed,
        reversedAt: reversed ? new Date() : null,
        staffId: staffId[StaffRole.CASHIER]!,
      },
    });

  const report = async (
    query: Record<string, string> = {},
    role: StaffRole = StaffRole.CASHIER,
  ): Promise<Report> =>
    (
      await request(server())
        .get('/api/v1/staff/reports/cash')
        .query(query)
        .set(auth(role))
        .expect(200)
    ).body as Report;

  it('expects the cash a bill was settled with, and records the difference (cash.count)', async () => {
    // A Restaurant bill, sent to the kitchen, settled in cash at the till.
    let bill = (
      await request(server())
        .post('/api/v1/staff/orders')
        .set(auth(StaffRole.CASHIER))
        .set('Idempotency-Key', randomUUID())
        .send({ department: Department.RESTAURANT })
        .expect(201)
    ).body as Bill;
    orderId = bill.id;

    bill = (
      await request(server())
        .put(`/api/v1/staff/orders/${bill.id}/lines`)
        .set(auth(StaffRole.CASHIER))
        .send({ version: bill.version, menuItemId: dishId, qty: 1 })
        .expect(200)
    ).body as Bill;
    bill = (
      (
        await request(server())
          .post(`/api/v1/staff/orders/${bill.id}/confirm`)
          .set(auth(StaffRole.CASHIER))
          .send({ version: bill.version })
          .expect(200)
      ).body as { order: Bill }
    ).order;
    bill = (
      await request(server())
        .post(`/api/v1/staff/orders/${bill.id}/payment`)
        .set(auth(StaffRole.CASHIER))
        .send({ version: bill.version })
        .expect(200)
    ).body as Bill;
    expect(bill.totals.balanceKobo).toBe(DISH_PRICE);

    await request(server())
      .post(`/api/v1/staff/orders/${bill.id}/settle`)
      .set(auth(StaffRole.CASHIER))
      .set('Idempotency-Key', randomUUID())
      .send({
        version: bill.version,
        payments: [{ method: PaymentMethod.CASH, amountKobo: DISH_PRICE }],
      })
      .expect(200);

    const response = await count(StaffRole.CASHIER, {
      businessDate: today(),
      countedKobo: DISH_PRICE - 20000,
    }).expect(201);
    const recorded = response.body as CashCount;

    expect(recorded).toMatchObject({
      businessDate: today(),
      staffId: staffId[StaffRole.CASHIER],
      staffName: staffName[StaffRole.CASHIER],
      expectedKobo: DISH_PRICE,
      countedKobo: DISH_PRICE - 20000,
      differenceKobo: -20000,
    });
    expect(recorded.number).toMatch(/^CASH-\d{6}$/);

    const stored = await prisma.cashCount.findUniqueOrThrow({
      where: { number: recorded.number },
    });
    expect(stored).toMatchObject({
      expectedKobo: DISH_PRICE,
      countedKobo: DISH_PRICE - 20000,
      differenceKobo: -20000,
    });

    // Its audit row, in plain sentences, under its number.
    const history = await request(server())
      .get('/api/v1/staff/audit')
      .query({ ref: recorded.number })
      .set(auth(StaffRole.OWNER))
      .expect(200);
    const [row] = (
      history.body as {
        data: {
          action: string;
          actionLabel: string;
          module: string;
          actorName: string;
          changes: string[];
        }[];
      }
    ).data;
    expect(row).toMatchObject({
      action: 'cash.count',
      actionLabel: 'Cash Counted',
      module: 'Point of Sale',
    });
    expect(row.changes).toEqual(
      expect.arrayContaining([
        `Business Date: ${today()}.`,
        'Expected: ₦5,000.',
        'Counted: ₦4,800.',
        'Difference: -₦200.',
      ]),
    );
  });

  it('counts only non-reversed cash dated that day, refunds included', async () => {
    const before = (
      await count(StaffRole.CASHIER, {
        businessDate: today(),
        countedKobo: 0,
      }).expect(201)
    ).body as CashCount;

    await payment(300000, PaymentMethod.CASH, today());
    await payment(700000, PaymentMethod.CASH, today(), true);
    await payment(400000, PaymentMethod.CARD, today());
    await payment(250000, PaymentMethod.TRANSFER, today());
    await payment(-50000, PaymentMethod.CASH, today());
    await payment(900000, PaymentMethod.CASH, yesterday());

    const after = (
      await count(StaffRole.CASHIER, {
        businessDate: today(),
        countedKobo: before.expectedKobo + 250000,
      }).expect(201)
    ).body as CashCount;

    expect(after.expectedKobo).toBe(before.expectedKobo + 300000 - 50000);
    expect(after.differenceKobo).toBe(0);

    // Several counts per date; the earlier keeps its own figures.
    const earlier = await prisma.cashCount.findUniqueOrThrow({
      where: { number: before.number },
    });
    expect(earlier.expectedKobo).toBe(before.expectedKobo);

    const past = (
      await count(StaffRole.CASHIER, {
        businessDate: yesterday(),
        countedKobo: 1000000,
      }).expect(201)
    ).body as CashCount;
    expect(past).toMatchObject({
      businessDate: yesterday(),
      expectedKobo: 900000,
      differenceKobo: 100000,
    });
  });

  it('refuses a count it cannot record, with the demo’s sentences', async () => {
    const future = await count(StaffRole.CASHIER, {
      businessDate: tomorrow(),
      countedKobo: 100,
    }).expect(400);
    expect(messageOf(future)).toBe(CASH_FUTURE_MESSAGE);

    for (const countedKobo of [-1, 1.5, '100', null, undefined, 2 ** 31]) {
      const refused = await count(StaffRole.CASHIER, {
        businessDate: today(),
        countedKobo,
      }).expect(400);
      expect(sentencesOf(refused)).toEqual([CASH_COUNT_MESSAGE]);
    }

    for (const businessDate of [
      undefined,
      '2026-02-30',
      `${today()}T00:00:00Z`,
    ]) {
      const refused = await count(StaffRole.CASHIER, {
        businessDate,
        countedKobo: 100,
      }).expect(400);
      expect(sentencesOf(refused)).toEqual([CASH_DATE_MESSAGE]);
    }
  });

  it('only the Cashier and managers count cash', async () => {
    for (const role of [
      StaffRole.WAITER,
      StaffRole.BARTENDER,
      StaffRole.KITCHEN,
      StaffRole.RECEPTION,
      StaffRole.STOREKEEPER,
    ]) {
      const refused = await count(role, {
        businessDate: today(),
        countedKobo: 100,
      }).expect(403);
      expect(messageOf(refused)).toBe(ROLE_REFUSED_MESSAGE);

      await request(server())
        .get('/api/v1/staff/reports/cash')
        .set(auth(role))
        .expect(403);
    }

    for (const role of [StaffRole.MANAGER, StaffRole.OWNER]) {
      const recorded = (
        await count(role, { businessDate: today(), countedKobo: 100 }).expect(
          201,
        )
      ).body as CashCount;
      expect(recorded.staffId).toBe(staffId[role]);
    }
  });

  it('a retried count replays the first, under its Idempotency-Key', async () => {
    const key = randomUUID();
    const body = { businessDate: today(), countedKobo: 123400 };
    const before = await prisma.cashCount.count();

    const first = await count(StaffRole.CASHIER, body, key).expect(201);
    const retry = await count(StaffRole.CASHIER, body, key).expect(201);

    expect(retry.body).toEqual(first.body);
    expect(await prisma.cashCount.count()).toBe(before + 1);

    const reused = await count(
      StaffRole.CASHIER,
      { ...body, countedKobo: 1 },
      key,
    ).expect(409);
    expect(messageOf(reused)).toBe(IDEMPOTENCY_KEY_REUSED);

    const missing = await count(StaffRole.CASHIER, body, null).expect(400);
    expect(messageOf(missing)).toBe(IDEMPOTENCY_KEY_REQUIRED);
    expect(await prisma.cashCount.count()).toBe(before + 1);
  });

  it('reports the counts of a range, the cash taken and the latest difference', async () => {
    const todays = await report();
    expect(todays).toMatchObject({ from: today(), to: today() });
    expect(todays.data.every((row) => row.businessDate === today())).toBe(true);
    expect(todays.total).toBe(
      await prisma.cashCount.count({
        where: { businessDate: new Date(`${today()}T00:00:00.000Z`) },
      }),
    );
    // The bill's ₦5,000, then ₦3,000 less a ₦500 refund.
    expect(todays.cashReceivedKobo).toBe(500000 + 300000 - 50000);

    const last = await count(StaffRole.CASHIER, {
      businessDate: today(),
      countedKobo: 0,
    }).expect(201);
    expect((await report()).latestDifferenceKobo).toBe(
      (last.body as CashCount).differenceKobo,
    );

    const both = await report(
      { from: yesterday(), to: today(), pageSize: '100' },
      StaffRole.MANAGER,
    );
    expect(both.total).toBe(todays.total + 2);
    expect(both.cashReceivedKobo).toBe(todays.cashReceivedKobo + 900000);
    expect(both.data.map((row) => row.number)).toEqual(
      [...both.data]
        .sort((a, b) => a.number.localeCompare(b.number))
        .map((row) => row.number),
    );

    await request(server())
      .get('/api/v1/staff/reports/cash')
      .query({ from: today(), to: yesterday() })
      .set(auth(StaffRole.CASHIER))
      .expect(400);
  });
});
