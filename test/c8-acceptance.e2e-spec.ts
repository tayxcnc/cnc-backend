/*
 * CNC's Paystack key for this walk, set before the app is built so nothing
 * depends on the developer's `.env`. It signs this walk's fake webhooks
 * only: the client is `FakePaystackClient`, so no card is charged.
 */
const PAYSTACK_KEY = 'sk_test_cnc_c8_acceptance_e2e_not_a_real_key';

process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  WasteReason,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import {
  CUSTOMER_REFRESH_COOKIE,
  STAFF_REFRESH_COOKIE,
} from '../src/auth/refresh-cookie';
import { buildCncDocument } from '../src/cnc-swagger';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import {
  LIMITED_DECISIONS,
  OWNER_ONLY_ACTIONS,
  OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE,
  OWNER_ONLY_NEW_MENU_ITEM_MESSAGE,
  OWNER_ONLY_PRICE_MESSAGE,
  OWNER_ONLY_SETTINGS_MESSAGE,
  OWNER_ONLY_TIMES_MESSAGE,
  approvalLimitMessage,
  ownerOnlyMessage,
} from '../src/money-control/money-control.service';
import { WebhookDispatcherService } from '../src/payments/webhook-dispatcher.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { StockLedgerService } from '../src/stock/stock-ledger.service';
import { createTestApp, sentMail } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { chargeSuccessBody, postSignedWebhook } from './paystack-webhooks';
import { createStaffAccount } from './staff-fixtures';
import { clientAddress } from './staff-sessions';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Auth = Record<string, string>;

/** Every response this walk received: line 8 searches all of them. */
interface Seen {
  who: string;
  method: string;
  path: string;
  status: number;
  text: string;
}

interface Bill {
  id: string;
  number: string;
  version: number;
  status: OrderStatus;
  channel: string;
  totals: { totalKobo: number; balanceKobo: number };
  payments: unknown[];
}

interface Customer {
  key: 'A' | 'B';
  id: string;
  email: string;
  phone: string;
  street: string;
  auth: Auth;
  orderNumber: string;
  onlineId: string;
  bookingId: string;
}

const ROLES: StaffRole[] = [
  StaffRole.OWNER,
  StaffRole.MANAGER,
  StaffRole.CASHIER,
  StaffRole.WAITER,
  StaffRole.BARTENDER,
  StaffRole.KITCHEN,
  StaffRole.STOREKEEPER,
  StaffRole.RECEPTION,
];

/** The roles plan §6.1 gives no page that shows a customer's contact. */
const NO_CUSTOMER_CONTACT: StaffRole[] = [
  StaffRole.WAITER,
  StaffRole.BARTENDER,
  StaffRole.KITCHEN,
  StaffRole.STOREKEEPER,
];

/** ₦40,000 a carton of one: two cartons are above the ₦50,000 limit. */
const STEAK_KOBO = 4_000_000;
/** The seeded Owner Approval Limit (₦50,000). */
const LIMIT_KOBO = 5_000_000;

/**
 * The Backend Brief's acceptance list (§12), run end to end, one test per
 * line, in the brief's order (plan §15, C8-6), against the API and
 * Postgres with Paystack faked:
 *
 * 1. the staff app's 107 domain tests, restated by the plan as the ported
 *    e2e and report specs: `docs/demo-tests-map.md` maps each to the spec
 *    that runs it, and this test holds the map to the specs;
 * 2. a Manager calling each Owner-only command, or a limited command above
 *    the limit, gets 403 and changes nothing; the Owner succeeds;
 * 3. `check:consistency`, restated: the menu and the settings the website
 *    reads come from the one API the staff app writes (D27);
 * 4. two cashiers settling one bill;
 * 5. two guests booking one table and date;
 * 6. a table freed by Reception is available on the website at once;
 * 7. a web order paid through the provider in Online Orders and in POS
 *    history, tagged Online, with its docket;
 * 8. no response carries a card number, a sign-in code, a credential hash,
 *    a refresh token or another customer's data: every GET route and every
 *    write route, as two customers and each staff role, plus every
 *    response this walk received.
 *
 * On a database of its own with the real seeds, the clock at the next
 * noon in Jos.
 */
describe('C8-6: the Backend Brief’s acceptance list (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let dispatcher: WebhookDispatcherService;

  const seen: Seen[] = [];
  const staff = {} as Record<StaffRole, { id: string; auth: Auth }>;
  let cashier2: Auth;
  const customers = {} as Record<'A' | 'B', Customer>;
  /** Every sign-in code mailed during the walk. */
  const codes: string[] = [];
  /** Every refresh token set in a cookie during the walk. */
  const refreshTokens: string[] = [];

  let food: { id: string; slug: string; priceKobo: number };
  let steak: { id: string };
  let vendorId: string;

  const server = () => app.getHttpServer();
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  /** A request, recorded. Each from a fresh client address. */
  async function call(
    who: string,
    method: Method,
    path: string,
    options: { auth?: Auth; body?: unknown; key?: boolean } = {},
  ): Promise<request.Response> {
    let pending = request(server())
      [method](`/api/v1${path}`)
      .set('X-Forwarded-For', clientAddress());

    if (options.auth) pending = pending.set(options.auth);
    if (options.key) pending = pending.set('Idempotency-Key', randomUUID());

    const response =
      options.body === undefined
        ? await pending
        : await pending.send(options.body as object);

    seen.push({
      who,
      method: method.toUpperCase(),
      path,
      status: response.status,
      text: response.text ?? '',
    });

    const cookies = response.headers['set-cookie'] as unknown as
      string[] | undefined;

    for (const line of cookies ?? []) {
      for (const name of [CUSTOMER_REFRESH_COOKIE, STAFF_REFRESH_COOKIE]) {
        if (line.startsWith(`${name}=`)) {
          const value = line.split(';')[0].slice(name.length + 1);

          if (value !== '') refreshTokens.push(decodeURIComponent(value));
        }
      }
    }

    return response;
  }

  const as = (role: StaffRole) => staff[role].auth;
  const bill = async (role: StaffRole, id: string) =>
    (await call(role, 'get', `/staff/orders/${id}`, { auth: as(role) }))
      .body as Bill;

  /** A Restaurant bill of `qty` of the test dish, sent to the kitchen. */
  async function sentBill(qty = 1): Promise<Bill> {
    const opened = (
      await call('CASHIER', 'post', '/staff/orders', {
        auth: as(StaffRole.CASHIER),
        key: true,
        body: { department: Department.RESTAURANT },
      })
    ).body as Bill;
    const lined = (
      await call('CASHIER', 'put', `/staff/orders/${opened.id}/lines`, {
        auth: as(StaffRole.CASHIER),
        body: { version: opened.version, menuItemId: food.id, qty },
      })
    ).body as Bill;
    return (
      (
        await call('CASHIER', 'post', `/staff/orders/${opened.id}/confirm`, {
          auth: as(StaffRole.CASHIER),
          body: { version: lined.version },
        })
      ).body as { order: Bill }
    ).order;
  }

  /** A sent bill, handed to payment. */
  async function readyBill(qty = 1): Promise<Bill> {
    const sent = await sentBill(qty);

    return (
      await call('CASHIER', 'post', `/staff/orders/${sent.id}/payment`, {
        auth: as(StaffRole.CASHIER),
        body: { version: sent.version },
      })
    ).body as Bill;
  }

  const settle = (auth: Auth, who: string, ready: Bill) =>
    call(who, 'post', `/staff/orders/${ready.id}/settle`, {
      auth,
      key: true,
      body: {
        version: ready.version,
        payments: [
          { method: PaymentMethod.CASH, amountKobo: ready.totals.balanceKobo },
        ],
      },
    });

  /** The Lagos date `days` from today, as YYYY-MM-DD. */
  const day = (days: number) =>
    formatIsoDate(addDays(watToday(new Date()), days));

  /** A paid web order for delivery, as `customer` (or a guest). */
  async function webOrder(
    who: string,
    contact: { name: string; phone: string; email: string; street: string },
    auth: Auth | undefined,
    qty: number,
  ): Promise<{ number: string; onlineId: string }> {
    const created = await call(who, 'post', '/checkouts', {
      auth,
      key: true,
      body: {
        lines: [{ dishId: food.slug, qty }],
        fulfilment: 'DELIVERY',
        address: {
          zone: 'JOS',
          street: contact.street,
          area: 'Rayfield',
          town: 'Jos',
          landmark: 'By the gate',
        },
        timing: 'ASAP',
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        note: 'Ring twice',
      },
    });

    expect(created.status).toBe(201);
    const { reference, sums } = created.body as {
      reference: string;
      sums: { totalKobo: number };
    };

    await postSignedWebhook(
      app,
      chargeSuccessBody(reference, sums.totalKobo),
      PAYSTACK_KEY,
    ).expect(200);
    await dispatcher.settled();

    const online = await prisma.onlineOrder.findUniqueOrThrow({
      where: { paystackReference: reference },
      include: { order: { select: { number: true } } },
    });

    return { number: online.order.number, onlineId: online.id };
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    dispatcher = app.get(WebhookDispatcherService, { strict: false });
    await seedData(prisma);
    fakeDateOnly(nextNoonInJos());

    // Every staff role signs in through the route, so its refresh token is
    // one line 8 looks for.
    for (const role of [...ROLES, 'CASHIER2' as const]) {
      const account = await createStaffAccount(
        prisma,
        role === 'CASHIER2' ? StaffRole.CASHIER : role,
        { emailPrefix: 'acceptance' },
      );
      const signed = await call(role, 'post', '/auth/staff/sign-in', {
        body: { email: account.email, password: account.password },
      });

      expect(signed.status).toBe(200);
      const auth = {
        Authorization: `Bearer ${(signed.body as { accessToken: string }).accessToken}`,
      };

      if (role === 'CASHIER2') cashier2 = auth;
      else staff[role] = { id: account.id, auth };
    }

    food = await prisma.menuItem.findFirstOrThrow({
      where: {
        active: true,
        showOnline: true,
        department: Department.RESTAURANT,
        choiceOptions: { isEmpty: true },
        priceKobo: { gt: 0 },
      },
      orderBy: { slug: 'asc' },
    });

    // Steak in the Kitchen with a pack cost, for the write-off, the count
    // and the requisition of line 2 (the approvals suite's set-up).
    vendorId = (
      (
        await call('STOREKEEPER', 'post', '/staff/vendors', {
          auth: as(StaffRole.STOREKEEPER),
          key: true,
          body: {
            name: 'Acceptance Foods',
            service: 'Food',
            phone: '08000000031',
          },
        })
      ).body as { id: string }
    ).id;
    steak = (
      await call('MANAGER', 'post', '/staff/stock/items', {
        auth: as(StaffRole.MANAGER),
        body: {
          name: 'Acceptance Steak',
          unit: 'portion',
          pack: 'carton',
          factor: 1,
          minimum: 15,
        },
      })
    ).body as { id: string };

    const costs = (
      await call('STOREKEEPER', 'post', '/staff/purchases', {
        auth: as(StaffRole.STOREKEEPER),
        key: true,
        body: {
          vendorId,
          lines: [{ stockItemId: steak.id, qty: 1, costKobo: STEAK_KOBO }],
        },
      })
    ).body as { id: string; version: number };

    await call('OWNER', 'post', `/staff/purchases/${costs.id}/approve`, {
      auth: as(StaffRole.OWNER),
      body: { version: costs.version },
    });

    const ledger = app.get(StockLedgerService, { strict: false });

    await prisma.$transaction((tx) =>
      ledger.move(tx, {
        stockItemId: steak.id,
        location: StockLocation.KITCHEN,
        qty: 200,
        type: StockMovementType.STOCK_COUNT,
        ref: 'Opening balance',
        staffId: null,
      }),
    );

    // Two customers, signed in with their codes, each with a phone, an
    // address, an app booking and a paid web order.
    for (const [key, n] of [
      ['A', 1],
      ['B', 2],
    ] as const) {
      const email = `acceptance-${key.toLowerCase()}-${randomUUID()}@cnc.test`;
      const phone = `0803111000${n}`;
      const street = `${n}${n} ${randomUUID().slice(0, 6)} Road`;

      await call(key, 'post', '/auth/code', { body: { email } });
      const code = sentMail(app)
        .lastTo(email)
        ?.text.match(/\b(\d{6})\b/)?.[1];

      expect(code).toBeDefined();
      codes.push(code!);

      const verified = await call(key, 'post', '/auth/verify', {
        body: { email, code },
      });
      const body = verified.body as {
        accessToken: string;
        customer: { id: string };
      };
      const auth = { Authorization: `Bearer ${body.accessToken}` };

      await call(key, 'patch', '/me', {
        auth,
        body: {
          name: `Customer ${key}`,
          phone,
          address: {
            zone: 'JOS',
            street,
            area: 'Rayfield',
            town: 'Jos',
            landmark: 'By the gate',
          },
        },
      });

      const booked = await call(key, 'post', '/reservations', {
        auth,
        key: true,
        body: {
          venue: 'lounge',
          table: n === 1 ? 'TS1' : 'TS2',
          businessDate: day(3),
          time: '19:00',
          party: 2,
          name: `Customer ${key}`,
          phone,
          email,
        },
      });

      expect(booked.status).toBe(201);

      const order = await webOrder(
        key,
        { name: `Customer ${key}`, phone, email, street },
        auth,
        1,
      );

      customers[key] = {
        key,
        id: body.customer.id,
        email,
        phone,
        street,
        auth,
        orderNumber: order.number,
        onlineId: order.onlineId,
        bookingId: (booked.body as { id: string }).id,
      };
    }
  }, 180_000);

  afterAll(async () => {
    jest.useRealTimers();
    await dispatcher?.settled();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  it('1. all 107 staff domain tests pass against the server rules, including owner.test.cjs (as the ported e2e and report specs)', () => {
    const map = readFileSync(
      join(__dirname, '..', 'docs', 'demo-tests-map.md'),
      'utf8',
    );
    // | suite | demo test | backend spec | backend test |
    const rows = map
      .split('\n')
      .filter((line) => /^\| `[a-z]+\.test\.cjs` \|/.test(line))
      .map((line) =>
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );

    expect(rows).toHaveLength(107);

    const bySuite = (suite: string) =>
      rows.filter(([cell]) => cell === `\`${suite}.test.cjs\``).length;

    expect({
      domain: bySuite('domain'),
      overview: bySuite('overview'),
      revision: bySuite('revision'),
      attendance: bySuite('attendance'),
      ux: bySuite('ux'),
      exports: bySuite('exports'),
      payments: bySuite('payments'),
      stock: bySuite('stock'),
      owner: bySuite('owner'),
    }).toEqual({
      domain: 34,
      overview: 5,
      revision: 16,
      attendance: 6,
      ux: 10,
      exports: 3,
      payments: 7,
      stock: 10,
      owner: 16,
    });

    // The ten with no server counterpart are the browser's own.
    const browserOnly = rows.filter(([, , spec]) => spec === 'staff app only');

    expect(browserOnly.map(([suite]) => suite).sort()).toEqual([
      ...Array<string>(3).fill('`exports.test.cjs`'),
      ...Array<string>(7).fill('`ux.test.cjs`'),
    ]);

    // Every other row names specs that exist and tests they run: the title
    // must open a plain `it(` or `test(` call (or an `.each(…)(` one), so
    // the map cannot point at a test that was renamed or removed, or at a
    // title left in a comment.
    const escaped = (text: string) =>
      text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const opensTest = (bare: string) =>
      new RegExp(
        String.raw`\b(?:it|test)(?:\.each\([^)]*\))?\(\s*['"\x60]` +
          escaped(bare),
      );

    for (const [suite, demo, spec, titles] of rows) {
      if (spec === 'staff app only') continue;

      const files = spec.split(', ').map((cell) => cell.replace(/`/g, ''));
      const sources = files.map((file) => {
        const path = join(__dirname, '..', file);

        expect({ file, exists: existsSync(path) }).toEqual({
          file,
          exists: true,
        });

        return readFileSync(path, 'utf8');
      });

      for (const title of titles.split(' + ')) {
        const bare = title.replace(/^"|"$/g, '');

        expect({
          suite,
          demo,
          bare,
          held: sources.some((source) => opensTest(bare).test(source)),
        }).toEqual({ suite, demo, bare, held: true });
      }
    }

    // Nothing skipped, left to do or focused anywhere a suite lives: Jest
    // reports a skipped test without failing the run, so a mapped test
    // could stop running while this line stayed green, and a focused one
    // silently skips the rest of its file.
    const root = join(__dirname, '..');
    const parked =
      /\b(?:it|test|describe)\.(?:skip|todo|only)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/;
    const specs = ['src', 'test', 'scripts', 'prisma'].flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
        .filter((file) => /\.(?:e2e-)?spec\.ts$/.test(file))
        .map((file) => join(dir, file)),
    );

    expect(specs.length).toBeGreaterThan(100);
    expect(
      specs.filter((file) =>
        parked.test(readFileSync(join(root, file), 'utf8')),
      ),
    ).toEqual([]);
  });

  it('2. a Manager calling an Owner-only command, or a limited one above the limit, gets 403 and changes nothing; the Owner succeeds', async () => {
    const manager = as(StaffRole.MANAGER);
    const owner = as(StaffRole.OWNER);
    const auditCount = () => prisma.auditLog.count();
    const ledgerCount = () => prisma.approvalLedger.count();

    /**
     * The Manager's call is refused with `message` and moves no audit row,
     * no ledger row and nothing `state` reads; the Owner's call succeeds.
     */
    async function ownerOnly(
      name: string,
      state: () => Promise<unknown>,
      managerCall: () => Promise<request.Response>,
      message: string,
      ownerCall: () => Promise<request.Response>,
    ) {
      const before = {
        state: await state(),
        audit: await auditCount(),
        ledger: await ledgerCount(),
      };
      const refused = await managerCall();

      expect({
        name,
        status: refused.status,
        message: [messageOf(refused)].flat()[0],
      }).toEqual({ name, status: 403, message });
      expect({
        name,
        state: await state(),
        audit: await auditCount(),
        ledger: await ledgerCount(),
      }).toEqual({ name, ...before });

      const allowed = await ownerCall();

      expect({ name, status: allowed.status < 300 }).toEqual({
        name,
        status: true,
      });
    }

    // Reverse a paid bill (D35).
    const paid = (
      await settle(as(StaffRole.CASHIER), 'CASHIER', await readyBill())
    ).body as Bill;
    await ownerOnly(
      'order.reverse',
      () => bill(StaffRole.OWNER, paid.id),
      () =>
        call('MANAGER', 'post', `/staff/orders/${paid.id}/reverse`, {
          auth: manager,
          body: { version: paid.version, reason: 'Wrong bill' },
        }),
      ownerOnlyMessage(OWNER_ONLY_ACTIONS.reverseBill),
      () =>
        call('OWNER', 'post', `/staff/orders/${paid.id}/reverse`, {
          auth: owner,
          body: { version: paid.version, reason: 'Wrong bill' },
        }),
    );

    // Correct a stock balance.
    const balance = () =>
      prisma.stockBalance.findUnique({
        where: {
          stockItemId_location: {
            stockItemId: steak.id,
            location: StockLocation.KITCHEN,
          },
        },
        select: { qty: true },
      });
    const adjust = (who: string, auth: Auth) =>
      call(who, 'post', '/staff/stock/adjustments', {
        auth,
        key: true,
        body: {
          stockItemId: steak.id,
          location: StockLocation.KITCHEN,
          direction: 'ADD',
          qty: 1,
          reason: 'Found a carton',
        },
      });

    await ownerOnly(
      'stock.adjust',
      balance,
      () => adjust('MANAGER', manager),
      ownerOnlyMessage(OWNER_ONLY_ACTIONS.correctStockBalance),
      () => adjust('OWNER', owner),
    );

    // A price, and a new menu item.
    const item = () =>
      prisma.menuItem.findUniqueOrThrow({
        where: { id: food.id },
        select: { priceKobo: true, version: true },
      });
    const price = async (who: string, auth: Auth) =>
      call(who, 'patch', `/staff/menu/${food.id}`, {
        auth,
        body: {
          version: (await item()).version,
          priceKobo: food.priceKobo + 100,
        },
      });

    await ownerOnly(
      'menu.save price',
      item,
      () => price('MANAGER', manager),
      OWNER_ONLY_PRICE_MESSAGE,
      () => price('OWNER', owner),
    );
    food.priceKobo += 100;

    const category = await prisma.staffCategory.findFirstOrThrow({
      where: { department: Department.RESTAURANT },
    });
    const newDish = (who: string, auth: Auth) =>
      call(who, 'post', '/staff/menu', {
        auth,
        key: true,
        body: {
          name: `Acceptance Dish ${who}`,
          priceKobo: 150_000,
          department: Department.RESTAURANT,
          staffCategoryId: category.id,
        },
      });

    await ownerOnly(
      'menu.save new item',
      () => prisma.menuItem.count(),
      () => newDish('MANAGER', manager),
      OWNER_ONLY_NEW_MENU_ITEM_MESSAGE,
      () => newDish('OWNER', owner),
    );

    // The Owner-only settings: VAT, and a booking time (Q29).
    const settings = () =>
      prisma.settings.findUniqueOrThrow({ where: { singleton: true } });
    const saveSettings = async (
      who: string,
      auth: Auth,
      changes: Record<string, unknown>,
    ) =>
      call(who, 'patch', '/staff/settings', {
        auth,
        body: { version: (await settings()).version, ...changes },
      });

    await ownerOnly(
      'settings.save VAT',
      settings,
      () => saveSettings('MANAGER', manager, { vatBps: 800 }),
      OWNER_ONLY_SETTINGS_MESSAGE,
      () => saveSettings('OWNER', owner, { vatBps: 750 }),
    );
    await ownerOnly(
      'settings.save a booking time',
      settings,
      () => saveSettings('MANAGER', manager, { lastArrivalMinutes: 1350 }),
      OWNER_ONLY_TIMES_MESSAGE,
      async () =>
        saveSettings('OWNER', owner, {
          lastArrivalMinutes: (await settings()).lastArrivalMinutes,
        }),
    );

    // The opening hours (Q29).
    const hours = () =>
      prisma.openingHoursDay.findMany({ orderBy: { dayOfWeek: 'asc' } });
    const week = async () =>
      (await hours()).map((d) => ({
        dayOfWeek: d.dayOfWeek,
        isClosed: d.isClosed,
        opensAtMinutes: d.opensAtMinutes,
        closesAtMinutes: d.closesAtMinutes,
      }));

    await ownerOnly(
      'opening hours',
      hours,
      async () =>
        call('MANAGER', 'put', '/staff/opening-hours', {
          auth: manager,
          body: { days: await week() },
        }),
      OWNER_ONLY_TIMES_MESSAGE,
      async () =>
        call('OWNER', 'put', '/staff/opening-hours', {
          auth: owner,
          body: { days: await week() },
        }),
    );

    // A Manager account.
    const hire = (who: string, auth: Auth) =>
      call(who, 'post', '/staff/people', {
        auth,
        body: {
          name: 'New Manager',
          email: `acceptance-manager-${who.toLowerCase()}-${randomUUID()}@cnc.test`,
          role: StaffRole.MANAGER,
        },
      });

    await ownerOnly(
      'staff.save Manager account',
      () => prisma.staff.count(),
      () => hire('MANAGER', manager),
      OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE,
      () => hire('OWNER', owner),
    );

    // Above the ₦50,000 Owner Approval Limit: a discount, before payment.
    const big = await sentBill(Math.ceil((LIMIT_KOBO * 2) / food.priceKobo));
    const discount = async (who: string, auth: Auth) =>
      call(who, 'post', `/staff/orders/${big.id}/discount`, {
        auth,
        body: {
          version: (await bill(StaffRole.OWNER, big.id)).version,
          amountKobo: LIMIT_KOBO + 100,
          reason: 'Regular guest',
        },
      });

    await ownerOnly(
      'order.discount above the limit',
      () => bill(StaffRole.OWNER, big.id),
      () => discount('MANAGER', manager),
      approvalLimitMessage(LIMITED_DECISIONS.discount, LIMIT_KOBO),
      () => discount('OWNER', owner),
    );

    // A requisition of two cartons, ₦80,000.
    const requisition = (
      await call('STOREKEEPER', 'post', '/staff/purchases', {
        auth: as(StaffRole.STOREKEEPER),
        key: true,
        body: {
          vendorId,
          lines: [{ stockItemId: steak.id, qty: 2, costKobo: STEAK_KOBO }],
        },
      })
    ).body as { id: string; version: number };
    const purchase = () =>
      prisma.purchase.findUniqueOrThrow({ where: { id: requisition.id } });
    const approvePurchase = (who: string, auth: Auth) =>
      call(who, 'post', `/staff/purchases/${requisition.id}/approve`, {
        auth,
        body: { version: requisition.version },
      });

    await ownerOnly(
      'purchase.approve above the limit',
      purchase,
      () => approvePurchase('MANAGER', manager),
      approvalLimitMessage(LIMITED_DECISIONS.purchase, LIMIT_KOBO),
      () => approvePurchase('OWNER', owner),
    );

    // A write-off of two cartons, ₦80,000.
    const logged = (
      await call('KITCHEN', 'post', '/staff/waste', {
        auth: as(StaffRole.KITCHEN),
        key: true,
        body: {
          location: StockLocation.KITCHEN,
          stockItemId: steak.id,
          qty: 2,
          reason: WasteReason.SPOILED,
        },
      })
    ).body as { id: string; version: number };
    const waste = () =>
      prisma.wasteEntry.findUniqueOrThrow({ where: { id: logged.id } });
    const approveWaste = (who: string, auth: Auth) =>
      call(who, 'post', `/staff/waste/${logged.id}/approve`, {
        auth,
        body: { version: logged.version },
      });

    await ownerOnly(
      'waste.approve above the limit',
      waste,
      () => approveWaste('MANAGER', manager),
      approvalLimitMessage(LIMITED_DECISIONS.writeOff, LIMIT_KOBO),
      () => approveWaste('OWNER', owner),
    );

    // A stock count whose difference is worth more than the limit (Q28).
    const count = async (who: string, auth: Auth) =>
      call(who, 'post', '/staff/stock/counts', {
        auth,
        key: true,
        body: {
          location: StockLocation.KITCHEN,
          counts: [
            {
              stockItemId: steak.id,
              counted: ((await balance())?.qty ?? 0) - 10,
            },
          ],
        },
      });

    await ownerOnly(
      'stock.count above the limit',
      balance,
      () => count('MANAGER', manager),
      approvalLimitMessage(LIMITED_DECISIONS.stockCount, LIMIT_KOBO),
      () => count('OWNER', owner),
    );

    // Cancelling a paid web order worth more than the limit.
    const guestOrder = await webOrder(
      'guest',
      {
        name: 'Big Order Guest',
        phone: '08035550000',
        email: `acceptance-big-${randomUUID()}@cnc.test`,
        street: '9 Big Order Road',
      },
      undefined,
      Math.ceil((LIMIT_KOBO * 2) / food.priceKobo),
    );
    const online = () =>
      prisma.onlineOrder.findUniqueOrThrow({
        where: { id: guestOrder.onlineId },
      });
    const cancel = async (who: string, auth: Auth) =>
      call(who, 'post', `/staff/online-orders/${guestOrder.onlineId}/cancel`, {
        auth,
        body: { version: (await online()).version, reason: 'Kitchen closed' },
      });

    await ownerOnly(
      'online.cancel above the limit',
      online,
      () => cancel('MANAGER', manager),
      approvalLimitMessage(LIMITED_DECISIONS.onlineChange, LIMIT_KOBO),
      () => cancel('OWNER', owner),
    );
  });

  it('3. the menu and the settings the website reads come from the one API the staff app writes (check:consistency, restated)', async () => {
    const staffItems: {
      slug: string;
      name: string;
      priceKobo: number;
      active: boolean;
      showOnline: boolean;
    }[] = [];

    for (let page = 1; ; page += 1) {
      const body = (
        await call('OWNER', 'get', `/staff/menu?page=${page}&pageSize=100`, {
          auth: as(StaffRole.OWNER),
        })
      ).body as { data: typeof staffItems; total: number };

      staffItems.push(...body.data);
      if (staffItems.length >= body.total || body.data.length === 0) break;
    }

    const site = (await call('site', 'get', '/menu')).body as {
      categories: {
        items: { slug: string; name: string; priceKobo: number }[];
      }[];
    };
    const shown = site.categories.flatMap((category) => category.items);
    const online = staffItems.filter((item) => item.active && item.showOnline);

    expect(shown.length).toBe(online.length);
    expect(
      Object.fromEntries(shown.map((i) => [i.slug, [i.name, i.priceKobo]])),
    ).toEqual(
      Object.fromEntries(online.map((i) => [i.slug, [i.name, i.priceKobo]])),
    );
    // Line 2's price change by the Owner is what the website shows.
    expect(shown.find((i) => i.slug === food.slug)?.priceKobo).toBe(
      food.priceKobo,
    );

    const settings = (
      (
        await call('OWNER', 'get', '/staff/settings', {
          auth: as(StaffRole.OWNER),
        })
      ).body as {
        settings: {
          vatBps: number;
          deliveryJosKobo: number;
          deliveryOutsideKobo: number;
        };
      }
    ).settings;
    const config = (await call('site', 'get', '/ordering/config')).body as {
      vatBps: number;
      zones: { zone: string; feeKobo: number }[];
    };

    expect(config.vatBps).toBe(settings.vatBps);
    expect(
      Object.fromEntries(config.zones.map((z) => [z.zone, z.feeKobo])),
    ).toEqual({
      JOS: settings.deliveryJosKobo,
      PLATEAU: settings.deliveryOutsideKobo,
    });

    // The quote prices from the same rows: VAT on the subtotal plus the fee.
    const quote = (
      await call('site', 'post', '/ordering/quote', {
        body: {
          lines: [{ dishId: food.slug, qty: 2 }],
          fulfilment: 'DELIVERY',
          zone: 'JOS',
        },
      })
    ).body as {
      sums: { subtotalKobo: number; vatKobo: number; deliveryKobo: number };
    };

    expect(quote.sums).toMatchObject({
      subtotalKobo: food.priceKobo * 2,
      vatKobo: Math.round((food.priceKobo * 2 * settings.vatBps) / 10000),
      deliveryKobo: settings.deliveryJosKobo,
    });
  });

  it('4. two cashiers settling the same bill: one succeeds, one gets the refresh message; payments are never duplicated', async () => {
    for (let round = 0; round < 3; round += 1) {
      const ready = await readyBill();
      const answers = await Promise.all([
        settle(as(StaffRole.CASHIER), 'CASHIER', ready),
        settle(cashier2, 'CASHIER2', ready),
      ]);

      expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
      expect(messageOf(answers.find((a) => a.status === 409)!)).toBe(
        STALE_VERSION_MESSAGE,
      );

      const after = await bill(StaffRole.CASHIER, ready.id);

      expect(after.status).toBe(OrderStatus.SETTLED);
      expect(await prisma.payment.count({ where: { orderId: ready.id } })).toBe(
        1,
      );
    }
  });

  it('5. two guests booking the same table and date at once: one succeeds', async () => {
    for (const [table, offset] of [
      ['TDS1', 5],
      ['TDS2', 6],
      ['TDS3', 7],
    ] as const) {
      const guest = (n: number) =>
        call(`guest ${n}`, 'post', '/reservations', {
          key: true,
          body: {
            venue: 'lounge',
            table,
            businessDate: day(offset),
            time: '19:00',
            party: 2,
            name: `Guest ${n}`,
            phone: '0803 123 4567',
            email: `acceptance-guest-${n}-${randomUUID()}@cnc.test`,
          },
        });
      const answers = await Promise.all([guest(1), guest(2)]);

      expect(answers.map((a) => a.status).sort()).toEqual([201, 409]);

      const tableRow = await prisma.diningTable.findFirstOrThrow({
        where: { code: table, venue: { slug: 'lounge' } },
      });

      expect(
        await prisma.reservation.count({
          where: {
            tableId: tableRow.id,
            businessDate: addDays(watToday(new Date()), offset),
          },
        }),
      ).toBe(1);
    }
  });

  it('6. a table freed in the staff app shows available on the website within one refresh', async () => {
    const table = await prisma.diningTable.findFirstOrThrow({
      where: { code: 'B1', venue: { slug: 'dining' } },
    });
    const website = async () => {
      const response = await call('site', 'get', '/venues/dining/availability');

      expect(response.headers['cache-control']).toBe('no-store');

      return (
        response.body as { tables: { code: string; status: string }[] }
      ).tables.find((t) => t.code === 'B1')?.status;
    };

    expect(await website()).toBe('AVAILABLE');

    const seated = (
      await call('RECEPTION', 'post', `/staff/tables/${table.id}/allocate`, {
        auth: as(StaffRole.RECEPTION),
        body: {
          status: TableSessionStatus.OCCUPIED,
          guest: 'Walk-in',
          party: 2,
        },
      })
    ).body as { id: string; version: number };

    expect(await website()).toBe('OCCUPIED');

    const released = await call(
      'RECEPTION',
      'post',
      `/staff/tables/${table.id}/release`,
      {
        auth: as(StaffRole.RECEPTION),
        body: { sessionId: seated.id, version: seated.version },
      },
    );

    expect(released.status).toBeLessThan(300);
    // The very next read: "within one refresh".
    expect(await website()).toBe('AVAILABLE');
  });

  it('7. a web order paid through the provider appears in staff Online Orders and Point of Sale history, tagged Online, with its docket', async () => {
    const { orderNumber, onlineId } = customers.A;
    const active = (
      await call('CASHIER', 'get', '/staff/online-orders?tab=ACTIVE', {
        auth: as(StaffRole.CASHIER),
      })
    ).body as { data: { id: string; orderNumber: string }[] };

    expect(active.data).toContainEqual(
      expect.objectContaining({ id: onlineId, orderNumber }),
    );

    const history = (
      await call(
        'CASHIER',
        'get',
        `/staff/orders?department=RESTAURANT&state=SETTLED&q=${orderNumber}`,
        { auth: as(StaffRole.CASHIER) },
      )
    ).body as { data: { number: string; channel: string }[] };

    expect(history.data).toEqual([
      expect.objectContaining({ number: orderNumber, channel: 'WEB' }),
    ]);

    const docket = (
      await call('KITCHEN', 'get', `/staff/dockets/KOT-${orderNumber}`, {
        auth: as(StaffRole.KITCHEN),
      })
    ).body as { channel: string; items: { menuItemId: string; qty: number }[] };

    expect(docket.channel).toBe('WEB');
    expect(docket.items).toEqual([
      expect.objectContaining({ menuItemId: food.id, qty: 1 }),
    ]);
  });

  it('8. no API response contains card numbers, sign-in codes or other customers’ data', async () => {
    const document = buildCncDocument(app);
    const routes = Object.entries(document.paths).flatMap(([path, item]) =>
      (['get', 'post', 'put', 'patch', 'delete'] as const)
        .filter((method) => item[method] !== undefined)
        .map((method) => ({ method, path: path.replace(/^\/api\/v1/, '') })),
    );
    const { A, B } = customers;
    const someone = await createStaffAccount(prisma, StaffRole.WAITER, {
      emailPrefix: 'acceptance-target',
    });
    const anyPurchase = await prisma.purchase.findFirstOrThrow();
    const anyWaste = await prisma.wasteEntry.findFirst();
    const anyTask = await prisma.task.findFirst();
    const anyAsset = await prisma.asset.findFirst();
    const anyCheckout = await prisma.checkout.findFirstOrThrow({
      where: { customerId: A.id },
    });
    const checkoutOfB = await prisma.checkout.findFirstOrThrow({
      where: { customerId: B.id },
    });
    const anyRefund = await prisma.onlineRefund.findFirst();
    const anyVendor = await prisma.vendor.findFirstOrThrow();
    const anyMaintenance = await prisma.maintenanceRecord.findFirst();
    const anyAttendance = await prisma.attendanceRecord.findFirst();
    const anyTable = await prisma.diningTable.findFirstOrThrow();

    /** Path parameters, from the records this walk made. */
    const fill = (path: string, as: 'A' | 'B' | 'none'): string[] => {
      const own = customers[as === 'B' ? 'B' : 'A'];
      const other = customers[as === 'B' ? 'A' : 'B'];
      const ownCheckout =
        as === 'A'
          ? [anyCheckout.reference]
          : as === 'B'
            ? [checkoutOfB.reference]
            : [];
      const values: Record<string, string[]> = {
        '/me/orders/{number}': [own.orderNumber, other.orderNumber],
        '/me/reservations/{id}': [own.bookingId, other.bookingId],
        '/staff/people/{id}': [someone.id],
        '/staff/menu/{id}': [food.id],
        '/staff/stock/items/{id}': [steak.id],
        '/staff/stock/requests/{id}': ['unknown'],
        '/staff/kitchen-mappings/{menuItemId}': [food.id],
        '/staff/purchases/{id}': [anyPurchase.id],
        '/staff/vendors/{id}': [anyVendor.id],
        '/staff/waste/{id}': [anyWaste?.id ?? 'unknown'],
        '/staff/tasks/{id}': [anyTask?.id ?? 'unknown'],
        '/staff/assets/{tag}': [anyAsset?.tag ?? 'AS-TEST'],
        '/staff/maintenance/{id}': [anyMaintenance?.id ?? 'unknown'],
        '/staff/attendance/{staffId}': [someone.id],
        '/staff/attendance/{id}': [anyAttendance?.id ?? 'unknown'],
        '/staff/dockets/{ref}': [`KOT-${A.orderNumber}`],
        '/staff/kitchen/entries/{docketRef}': [`KOT-${A.orderNumber}`],
        '/staff/kitchen/days/{date}': [day(0)],
        '/staff/reservations/{id}': [A.bookingId, B.bookingId],
        '/staff/tables/{id}': [anyTable.id],
        '/venues/{venue}': ['dining'],
        // The reference is the confirmation page's capability (122 random
        // bits): each customer reads their own, and a guess finds nothing.
        '/checkouts/{reference}': [...ownCheckout, `cnc-order-${randomUUID()}`],
        '/staff/online-orders/{id}': [A.onlineId, B.onlineId],
        '/staff/online-orders/checkouts/{checkoutId}': [anyCheckout.id],
        '/staff/online-orders/{id}/refunds/{refundId}': [
          `${A.onlineId}|${anyRefund?.id ?? 'unknown'}`,
        ],
      };
      for (const [template, candidates] of Object.entries(values)) {
        if (!path.startsWith(template)) continue;

        const rest = path.slice(template.length);

        if (template.includes('{refundId}')) {
          return candidates.map((pair) => {
            const [id, refundId] = pair.split('|');

            return `/staff/online-orders/${id}/refunds/${refundId}${rest}`;
          });
        }

        return candidates.map(
          (value) => template.replace(/\{[^}]+\}/, value) + rest,
        );
      }

      return [path];
    };

    const billIds = (
      await prisma.order.findMany({
        where: { number: { in: [A.orderNumber, B.orderNumber] } },
        select: { id: true },
      })
    ).map(({ id }) => id);

    /** Who calls: both customers, every staff role, and nobody. */
    const callers: { who: string; auth?: Auth; as: 'A' | 'B' | 'none' }[] = [
      { who: 'customer A', auth: A.auth, as: 'A' },
      { who: 'customer B', auth: B.auth, as: 'B' },
      ...ROLES.map((role) => ({
        who: role,
        auth: as(role),
        as: 'none' as const,
      })),
      { who: 'anonymous', as: 'none' },
    ];

    // Writes that would end the caller's session or account are left out:
    // they are proved in their own suites, and the sweep must keep reading.
    const skipped = new Set([
      'DELETE /me',
      'POST /auth/sign-out',
      'POST /auth/staff/sign-out',
    ]);

    // Every GET first, then every write with an empty body.
    for (const kind of ['read', 'write'] as const) {
      for (const route of routes) {
        const isRead = route.method === 'get';

        if (isRead !== (kind === 'read')) continue;
        if (skipped.has(`${route.method.toUpperCase()} ${route.path}`)) {
          continue;
        }

        for (const caller of callers) {
          const paths = route.path.startsWith('/staff/orders/{id}')
            ? billIds.map((id) => route.path.replace('{id}', id))
            : fill(route.path, caller.as);

          for (const path of paths) {
            await call(caller.who, route.method, path, {
              auth: caller.auth,
              ...(isRead ? {} : { body: {} }),
            });
          }
        }
      }
    }

    // What must never appear, read from the database at the end.
    const hashes = [
      ...(await prisma.otpCode.findMany({ select: { codeHash: true } })).map(
        (r) => r.codeHash,
      ),
      ...(await prisma.staff.findMany({ select: { passwordHash: true } })).map(
        (r) => r.passwordHash,
      ),
      ...(
        await prisma.refreshToken.findMany({ select: { tokenHash: true } })
      ).map((r) => r.tokenHash),
    ];
    const contactOf = (c: Customer) => [c.id, c.email, c.phone, c.street];

    /**
     * A run of 13 to 19 digits that passes the Luhn check: a card number.
     * Not the decimals of a number (the business's map coordinates).
     */
    const cardNumbers = (text: string) =>
      [...text.matchAll(/(?<![\d.])\d{13,19}(?![\d.])/g)]
        .map(([digits]) => digits)
        .filter((digits) => {
          let sum = 0;

          for (let i = 0; i < digits.length; i += 1) {
            let d = Number(digits[digits.length - 1 - i]);

            if (i % 2 === 1) {
              d *= 2;
              if (d > 9) d -= 9;
            }

            sum += d;
          }

          return sum % 10 === 0;
        });

    const problemsIn = (responses: Seen[]) => {
      const problems: string[] = [];

      for (const response of responses) {
        problems.push(...problemsOf(response));
      }

      return problems;
    };

    const problemsOf = (response: Seen): string[] => {
      const problems: string[] = [];
      const where = `${response.who} ${response.method} ${response.path} (${response.status})`;
      const text = response.text;

      if (cardNumbers(text).length > 0) {
        problems.push(`${where}: a card number`);
      }

      for (const code of codes) {
        if (new RegExp(`(?<!\\d)${code}(?!\\d)`).test(text)) {
          problems.push(`${where}: a sign-in code`);
        }
      }

      if (/"(passwordHash|codeHash|tokenHash)"/.test(text)) {
        problems.push(`${where}: a credential hash field`);
      }

      for (const hash of hashes) {
        if (text.includes(hash)) problems.push(`${where}: a credential hash`);
      }

      for (const token of refreshTokens) {
        if (text.includes(token)) problems.push(`${where}: a refresh token`);
      }

      // A customer never reads the other customer.
      if (response.who === 'customer A' || response.who === 'guest') {
        for (const detail of contactOf(B)) {
          if (text.includes(detail)) problems.push(`${where}: B's ${detail}`);
        }
      }

      if (response.who === 'customer B') {
        for (const detail of contactOf(A)) {
          if (text.includes(detail)) problems.push(`${where}: A's ${detail}`);
        }
      }

      // A staff role with no page that shows a customer reads none of them.
      if (NO_CUSTOMER_CONTACT.includes(response.who as StaffRole)) {
        for (const customer of [A, B]) {
          for (const detail of contactOf(customer).slice(1)) {
            if (text.includes(detail)) {
              problems.push(`${where}: ${customer.key}'s ${detail}`);
            }
          }
        }
      }

      // Nobody signed out reads either customer.
      if (response.who === 'anonymous' || response.who === 'site') {
        for (const customer of [A, B]) {
          for (const detail of contactOf(customer)) {
            if (text.includes(detail)) {
              problems.push(`${where}: ${customer.key}'s ${detail}`);
            }
          }
        }
      }

      return problems;
    };

    // The search finds what it looks for: a test card, a code, a hash, a
    // refresh token and the other customer's email, each planted once.
    const planted = (who: string, text: string): Seen => ({
      who,
      method: 'GET',
      path: '/planted',
      status: 200,
      text,
    });

    expect(
      [
        planted('OWNER', '{"pan":"4084084084084081"}'),
        planted('OWNER', `{"code":"${codes[0]}"}`),
        planted('OWNER', `{"x":"${hashes[0]}"}`),
        planted('OWNER', `{"x":"${refreshTokens[0]}"}`),
        planted('customer A', `{"email":"${B.email}"}`),
        planted('KITCHEN', `{"phone":"${A.phone}"}`),
      ].map((response) => problemsOf(response).length > 0),
    ).toEqual([true, true, true, true, true, true]);

    expect(problemsIn(seen)).toEqual([]);

    // The sweep reached every route as every caller, and read real records:
    // the Owner's GETs answered with data, and each customer read their own
    // order and booking.
    expect(seen.length).toBeGreaterThan(routes.length * callers.length);
    expect(
      seen.filter(
        (s) => s.who === 'OWNER' && s.method === 'GET' && s.status === 200,
      ).length,
    ).toBeGreaterThan(40);
    for (const customer of [A, B]) {
      expect(
        seen.some(
          (s) =>
            s.who === `customer ${customer.key}` &&
            s.path === `/me/orders/${customer.orderNumber}` &&
            s.status === 200,
        ),
      ).toBe(true);
      expect(
        seen.some(
          (s) =>
            s.who === `customer ${customer.key}` &&
            s.path ===
              `/me/orders/${customers[customer.key === 'A' ? 'B' : 'A'].orderNumber}` &&
            s.status === 404,
        ),
      ).toBe(true);
    }
  });
});
