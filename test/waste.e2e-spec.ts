import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  StaffRole,
  StockKind,
  StockLocation,
  StockMovementType,
  WasteReason,
  WasteStatus,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { ADMIN_REASON_MESSAGE } from '../src/common/admin-reason';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { IDEMPOTENCY_KEY_REQUIRED } from '../src/idempotency/idempotency-key.decorator';
import {
  approvalLimitMessage,
  dailyLimitMessage,
  LIMITED_DECISIONS,
  OWN_RECORD_KINDS,
  ownRecordMessage,
} from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { INT4_MAX } from '../src/prisma/int4';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { StockLedgerService } from '../src/stock/stock-ledger.service';
import {
  insufficientStockMessage,
  STOCK_LOCATION_MESSAGE,
} from '../src/stock/stock-messages';
import {
  BAR_WASTE_ONLY_MESSAGE,
  CREATE_ITEM_MESSAGE,
  CREATE_QTY_REASON_MESSAGE,
  EDIT_ITEM_MESSAGE,
  EDIT_QTY_REASON_MESSAGE,
  KITCHEN_WASTE_ONLY_MESSAGE,
  REVIEW_PENDING_WASTE_MESSAGE,
  STORE_WASTE_ONLY_MESSAGE,
  WASTE_NOT_FOUND_MESSAGE,
  WASTE_STATUS_MESSAGE,
  WASTE_VALUE_TOO_LARGE_MESSAGE,
  WASTE_VIEW_MESSAGE,
} from '../src/waste/waste-messages';
import { createTestApp } from './create-test-app';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * Waste (card C5-4) through HTTP and against Postgres: logging at each
 * location, the managers' approvals within the Owner's limits and never
 * their own, rejections, corrections and status changes, stock leaving
 * only on approval and only through the ledger, the coded valuation (Q25),
 * the read and the history. The C5 gate's steps 5 and 6 are walked first;
 * the demo's waste cases (`owner.test.cjs`, `domain.test.cjs`,
 * `stock.test.cjs`, `revision.test.cjs`) are ported by name.
 *
 * It runs on a database of its own (`createIsolatedDatabase`), seeded with
 * the real reference data (`seedData`): the approval limits are the seeded
 * ₦50,000 and ₦150,000, and on the shared test database other suites
 * change them while they run.
 */
describe('Waste (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let ledger: StockLedgerService;
  const originalUrl = process.env.CNC_DB_URL;

  type Actor =
    | 'owner'
    | 'manager'
    | 'manager2'
    | 'manager3'
    | 'kitchen'
    | 'bartender'
    | 'cashier'
    | 'storekeeper'
    | 'waiter'
    | 'reception';

  const ROLE: Record<Actor, StaffRole> = {
    owner: StaffRole.OWNER,
    manager: StaffRole.MANAGER,
    manager2: StaffRole.MANAGER,
    manager3: StaffRole.MANAGER,
    kitchen: StaffRole.KITCHEN,
    bartender: StaffRole.BARTENDER,
    cashier: StaffRole.CASHIER,
    storekeeper: StaffRole.STOREKEEPER,
    waiter: StaffRole.WAITER,
    reception: StaffRole.RECEPTION,
  };

  const staffId: Partial<Record<Actor, string>> = {};
  const token: Partial<Record<Actor, string>> = {};

  interface Waste {
    id: string;
    number: string;
    location: StockLocation;
    stockItemId: string;
    stockItemName: string;
    measure: string;
    qty: number;
    reason: WasteReason;
    note: string;
    status: WasteStatus;
    valueKobo: number;
    createdById: string;
    createdByName: string;
    decidedById: string | null;
    decidedByName: string | null;
    version: number;
  }

  interface WastePage {
    data: Waste[];
    total: number;
    pendingCount: number;
  }

  /** Rice: ₦70,000 a bag of 50 portions, so ₦1,400 a portion. */
  let rice: { id: string; name: string };
  /** Steak: ₦40,000 a carton of one, so each written off is ₦40,000. */
  let steak: { id: string; name: string };
  /** A seeded Bar drink, valued at its menu price. */
  let drink: { id: string; name: string; priceKobo: number };

  const RICE_BAG_KOBO = 7_000_000;
  const STEAK_KOBO = 4_000_000;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    ledger = app.get(StockLedgerService, { strict: false });
    const tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);

    for (const actor of Object.keys(ROLE) as Actor[]) {
      const account = await createStaffAccount(prisma, ROLE[actor], {
        emailPrefix: 'waste',
        name: `Waste ${actor}`,
      });
      staffId[actor] = account.id;
      token[actor] = await accessTokenFor(tokens, account.id);
    }

    rice = await kitchenItem('Waste Rice', 'bag', 50);
    steak = await kitchenItem('Waste Steak', 'carton', 1);

    // The pack costs: a requisition that is not Rejected or Cancelled sets
    // an item's latest cost (`latestPackCostKobo`), Pending included.
    const vendor = (
      await request(server())
        .post('/api/v1/staff/vendors')
        .set(as('storekeeper'))
        .set('Idempotency-Key', randomUUID())
        .send({ name: 'Waste Foods', service: 'Food', phone: '08000000020' })
        .expect(201)
    ).body as { id: string };

    await request(server())
      .post('/api/v1/staff/purchases')
      .set(as('storekeeper'))
      .set('Idempotency-Key', randomUUID())
      .send({
        vendorId: vendor.id,
        lines: [
          { stockItemId: rice.id, qty: 1, costKobo: RICE_BAG_KOBO },
          { stockItemId: steak.id, qty: 1, costKobo: STEAK_KOBO },
        ],
      })
      .expect(201);

    const barItem = await prisma.stockItem.findFirstOrThrow({
      where: { kind: StockKind.BAR, menuItemId: { not: null } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, menuItemId: true },
    });
    const menuItem = await prisma.menuItem.findUniqueOrThrow({
      where: { id: barItem.menuItemId! },
      select: { priceKobo: true },
    });
    drink = {
      id: barItem.id,
      name: barItem.name,
      priceKobo: menuItem.priceKobo,
    };

    // Opening balances, as a stock count would enter them (Q11).
    await prisma.$transaction(async (tx) => {
      const opening: [string, StockLocation, number][] = [
        [rice.id, StockLocation.KITCHEN, 500],
        [rice.id, StockLocation.STORE, 20],
        [steak.id, StockLocation.KITCHEN, 50],
        [drink.id, StockLocation.BAR, 1000],
      ];

      for (const [stockItemId, location, qty] of opening) {
        await ledger.move(tx, {
          stockItemId,
          location,
          qty,
          type: StockMovementType.STOCK_COUNT,
          ref: 'Opening balance',
          staffId: null,
        });
      }
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const as = (actor: Actor) => ({ Authorization: `Bearer ${token[actor]}` });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;
  /**
   * A refusal's sentences: the ValidationPipe answers a list, a service one
   * sentence. Compared with `[sentence]`, so a field answering its sentence
   * twice fails.
   */
  const sentencesOf = (response: request.Response): unknown[] => {
    const message = messageOf(response);

    return Array.isArray(message) ? (message as unknown[]) : [message];
  };

  async function kitchenItem(
    name: string,
    pack: string,
    factor: number,
  ): Promise<{ id: string; name: string }> {
    const response = await request(server())
      .post('/api/v1/staff/stock/items')
      .set(as('manager'))
      .send({ name, unit: 'portion', pack, factor, minimum: 15 })
      .expect(201);

    return response.body as { id: string; name: string };
  }

  const create = (
    actor: Actor,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) =>
    request(server())
      .post('/api/v1/staff/waste')
      .set(as(actor))
      .set('Idempotency-Key', key)
      .send(body);

  /** A waste entry logged through the route, expected to succeed. */
  async function log(
    actor: Actor,
    location: StockLocation,
    stockItemId: string,
    qty: number,
    reason: WasteReason = WasteReason.SPOILED,
  ): Promise<Waste> {
    return (
      await create(actor, { location, stockItemId, qty, reason }).expect(201)
    ).body as Waste;
  }

  const command = (
    actor: Actor,
    target: { id: string; version: number },
    path: 'approve' | 'reject' | 'status',
    body: Record<string, unknown> = {},
  ) =>
    request(server())
      .post(`/api/v1/staff/waste/${target.id}/${path}`)
      .set(as(actor))
      .send({ version: target.version, ...body });

  const edit = (
    actor: Actor,
    target: { id: string; version: number },
    body: Record<string, unknown>,
  ) =>
    request(server())
      .put(`/api/v1/staff/waste/${target.id}`)
      .set(as(actor))
      .send({ version: target.version, ...body });

  async function balance(
    stockItemId: string,
    location: StockLocation,
  ): Promise<number> {
    const row = await prisma.stockBalance.findUnique({
      where: { stockItemId_location: { stockItemId, location } },
      select: { qty: true },
    });

    return row?.qty ?? 0;
  }

  /** The balance must equal the sum of the item's movements at the location. */
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

  async function ledgerRows(actor: Actor) {
    return prisma.approvalLedger.findMany({
      where: { staffId: staffId[actor] },
      orderBy: { createdAt: 'asc' },
      select: { amountKobo: true, action: true, ref: true },
    });
  }

  async function stored(id: string) {
    return prisma.wasteEntry.findUniqueOrThrow({
      where: { id },
      select: { status: true, valueKobo: true, version: true, qty: true },
    });
  }

  describe('the C5 gate, steps 5 and 6', () => {
    it('5. a manager cannot approve their own waste entry', async () => {
      const kitchenBefore = await balance(rice.id, StockLocation.KITCHEN);
      const own = await log('manager', StockLocation.KITCHEN, rice.id, 2);

      const refused = await command('manager', own, 'approve').expect(403);
      expect(messageOf(refused)).toBe(
        ownRecordMessage(OWN_RECORD_KINDS.wasteEntry),
      );
      expect(messageOf(refused)).toBe(
        'You cannot approve a waste entry you created. The Owner or another manager must approve it.',
      );

      // Nothing moved, nothing counted, and the entry waits for someone else.
      expect((await stored(own.id)).status).toBe(WasteStatus.PENDING);
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(kitchenBefore);
      expect(await ledgerRows('manager')).toEqual([]);

      const approved = await command('manager2', own, 'approve').expect(200);
      expect(approved.body).toMatchObject({
        status: WasteStatus.APPROVED,
        decidedById: staffId.manager2,
        decidedByName: 'Waste manager2',
      });
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(
        kitchenBefore - 2,
      );
      await expectLedgerHolds(rice.id, StockLocation.KITCHEN);
    });

    it('6. the Daily Approval Limit refuses the approval that crosses ₦150,000', async () => {
      const entries: Waste[] = [];

      for (let n = 0; n < 4; n += 1) {
        entries.push(await log('kitchen', StockLocation.KITCHEN, steak.id, 1));
      }

      expect(entries.map((entry) => entry.valueKobo)).toEqual([
        STEAK_KOBO,
        STEAK_KOBO,
        STEAK_KOBO,
        STEAK_KOBO,
      ]);

      for (const entry of entries.slice(0, 3)) {
        await command('manager3', entry, 'approve').expect(200);
      }

      const steakBefore = await balance(steak.id, StockLocation.KITCHEN);
      const crossing = await command('manager3', entries[3], 'approve').expect(
        403,
      );
      expect(messageOf(crossing)).toBe(
        dailyLimitMessage(4 * STEAK_KOBO, 15_000_000),
      );
      expect(messageOf(crossing)).toBe(
        'This would take your approvals today to ₦160,000, above the Daily Approval Limit of ₦150,000. The Owner must approve it.',
      );
      expect((await stored(entries[3].id)).status).toBe(WasteStatus.PENDING);
      expect(await balance(steak.id, StockLocation.KITCHEN)).toBe(steakBefore);
      expect(await ledgerRows('manager3')).toEqual(
        entries.slice(0, 3).map((entry) => ({
          amountKobo: STEAK_KOBO,
          action: 'waste.approve',
          ref: entry.number,
        })),
      );

      // Another manager's day is their own, and the Owner has no limit.
      await command('owner', entries[3], 'approve').expect(200);
      expect(await balance(steak.id, StockLocation.KITCHEN)).toBe(
        steakBefore - 1,
      );
      expect(await ledgerRows('owner')).toEqual([]);
    });
  });

  describe('waste.create', () => {
    it('logs a Pending entry at each role’s own location, valued by the coded formula (Q25), and moves no stock', async () => {
      const kitchenBefore = await balance(rice.id, StockLocation.KITCHEN);
      const storeBefore = await balance(rice.id, StockLocation.STORE);

      const kitchen = await log(
        'kitchen',
        StockLocation.KITCHEN,
        rice.id,
        2,
        WasteReason.BURNT,
      );
      expect(kitchen).toMatchObject({
        location: StockLocation.KITCHEN,
        stockItemName: 'Waste Rice',
        measure: 'portion',
        qty: 2,
        reason: WasteReason.BURNT,
        status: WasteStatus.PENDING,
        valueKobo: 2 * (RICE_BAG_KOBO / 50),
        createdById: staffId.kitchen,
        createdByName: 'Waste kitchen',
        decidedById: null,
        version: 0,
      });
      expect(kitchen.number).toMatch(/^W-\d{6}$/);

      // Q25's own example: one bag of rice at ₦70,000 is ₦1,400 until the
      // founder answers it.
      const store = await log('storekeeper', StockLocation.STORE, rice.id, 1);
      expect(store).toMatchObject({ measure: 'bag', valueKobo: 140_000 });

      const bar = await log('bartender', StockLocation.BAR, drink.id, 3);
      expect(bar.valueKobo).toBe(3 * drink.priceKobo);
      const cashier = await log('cashier', StockLocation.BAR, drink.id, 1);
      expect(cashier.valueKobo).toBe(drink.priceKobo);

      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(kitchenBefore);
      expect(await balance(rice.id, StockLocation.STORE)).toBe(storeBefore);
    });

    it('refuses in the demo’s order: the location, the role’s own location, the quantity and reason, then the item', async () => {
      /** A body with the reason Burnt; `undefined` leaves a field out. */
      const entry = (
        location: string | undefined,
        stockItemId: string | undefined,
        qty: unknown,
      ) => ({ location, stockItemId, qty, reason: 'BURNT' });
      const K = 'KITCHEN';
      const cases: [Actor, Record<string, unknown>, number, string][] = [
        ['kitchen', entry(undefined, rice.id, 1), 400, STOCK_LOCATION_MESSAGE],
        ['kitchen', entry('BAR', drink.id, 1), 403, KITCHEN_WASTE_ONLY_MESSAGE],
        ['bartender', entry(K, rice.id, 1.5), 403, BAR_WASTE_ONLY_MESSAGE],
        ['cashier', entry(K, rice.id, 1), 403, BAR_WASTE_ONLY_MESSAGE],
        ['storekeeper', entry(K, rice.id, 1), 403, STORE_WASTE_ONLY_MESSAGE],
        ['kitchen', entry(K, rice.id, 1.5), 400, CREATE_QTY_REASON_MESSAGE],
        [
          'kitchen',
          { location: K, stockItemId: rice.id, qty: 1 },
          400,
          CREATE_QTY_REASON_MESSAGE,
        ],
        ['kitchen', entry(K, '', 0), 400, CREATE_QTY_REASON_MESSAGE],
        ['kitchen', entry(K, undefined, 1), 400, CREATE_ITEM_MESSAGE],
        ['manager', entry('BAR', rice.id, 1), 400, CREATE_ITEM_MESSAGE],
        ['manager', entry(K, 'missing', 1), 400, CREATE_ITEM_MESSAGE],
        ['waiter', entry('BAR', drink.id, 1), 403, ROLE_REFUSED_MESSAGE],
        ['reception', entry('BAR', drink.id, 1), 403, ROLE_REFUSED_MESSAGE],
      ];
      const before = await prisma.wasteEntry.count();

      for (const [actor, body, status, message] of cases) {
        const response = await create(actor, body).expect(status);
        expect([actor, sentencesOf(response)]).toEqual([actor, [message]]);
      }

      expect(await prisma.wasteEntry.count()).toBe(before);
    });

    it('takes an Idempotency-Key and replays a retry instead of logging twice', async () => {
      await request(server())
        .post('/api/v1/staff/waste')
        .set(as('kitchen'))
        .send({
          location: 'KITCHEN',
          stockItemId: rice.id,
          qty: 1,
          reason: 'BURNT',
        })
        .expect(400)
        .expect((response) =>
          expect(messageOf(response)).toBe(IDEMPOTENCY_KEY_REQUIRED),
        );

      const key = randomUUID();
      const body = {
        location: 'KITCHEN',
        stockItemId: rice.id,
        qty: 1,
        reason: 'BURNT',
      };
      const first = await create('kitchen', body, key).expect(201);
      const again = await create('kitchen', body, key).expect(201);

      expect((again.body as Waste).number).toBe((first.body as Waste).number);
      expect(
        await prisma.wasteEntry.count({
          where: { number: (first.body as Waste).number },
        }),
      ).toBe(1);
    });
  });

  describe('approve and reject', () => {
    it('pending waste does not deduct; approved waste deducts once', async () => {
      const before = await balance(rice.id, StockLocation.KITCHEN);
      const entry = await log('kitchen', StockLocation.KITCHEN, rice.id, 2);
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(before);

      const approved = (await command('manager', entry, 'approve').expect(200))
        .body as Waste;
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(before - 2);

      const again = await command('manager', approved, 'approve').expect(409);
      expect(messageOf(again)).toBe(REVIEW_PENDING_WASTE_MESSAGE);
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(before - 2);

      const movements = await prisma.stockMovement.findMany({
        where: { ref: entry.number },
        select: { qty: true, type: true, location: true, staffId: true },
      });
      expect(movements).toEqual([
        {
          qty: -2,
          type: StockMovementType.WASTE,
          location: StockLocation.KITCHEN,
          staffId: staffId.manager,
        },
      ]);

      // A Kitchen user cannot log a Bar drink in the Kitchen.
      const wrong = await create('kitchen', {
        location: 'KITCHEN',
        stockItemId: drink.id,
        qty: 1,
        reason: 'BROKEN',
      }).expect(400);
      expect(messageOf(wrong)).toMatch(/this location/);
    });

    it('waste write-offs above the limit need the Owner, and managers cannot approve waste they logged', async () => {
      const overQty = Math.floor(5_000_000 / drink.priceKobo) + 1;
      const big = await log('bartender', StockLocation.BAR, drink.id, overQty);
      expect(big.valueKobo).toBeGreaterThan(5_000_000);

      const refused = await command('manager', big, 'approve').expect(403);
      expect(messageOf(refused)).toBe(
        approvalLimitMessage(LIMITED_DECISIONS.writeOff, 5_000_000),
      );
      expect(messageOf(refused)).toBe(
        'This write-off is above the Owner Approval Limit of ₦50,000. The Owner must approve it.',
      );
      await command('owner', big, 'approve').expect(200);
      expect((await stored(big.id)).status).toBe(WasteStatus.APPROVED);

      const small = await log('bartender', StockLocation.BAR, drink.id, 1);
      await command('manager', small, 'approve').expect(200);

      const mine = await log('manager2', StockLocation.BAR, drink.id, 1);
      const own = await command('manager2', mine, 'approve').expect(403);
      expect(messageOf(own)).toMatch(/you created/);
      const ownByStatus = await command('manager2', mine, 'status', {
        status: 'APPROVED',
        reason: 'x',
      }).expect(403);
      expect(messageOf(ownByStatus)).toMatch(/you created/);

      // A manager may approve their own entry by no route; the Owner may
      // approve their own.
      const ownersOwn = await log('owner', StockLocation.BAR, drink.id, 1);
      await command('owner', ownersOwn, 'approve').expect(200);
      await command('manager', mine, 'approve').expect(200);
    });

    it('refuses an approval the location cannot cover, and counts nothing', async () => {
      const empty = await kitchenItem('Waste Empty', 'tray', 10);
      const entry = await log('kitchen', StockLocation.KITCHEN, empty.id, 1);

      const refused = await command('manager', entry, 'approve').expect(409);
      expect(messageOf(refused)).toBe(
        insufficientStockMessage(StockLocation.KITCHEN, 'Waste Empty'),
      );
      expect((await stored(entry.id)).status).toBe(WasteStatus.PENDING);
      expect(
        await prisma.approvalLedger.count({ where: { ref: entry.number } }),
      ).toBe(0);
    });

    it('lets a manager reject their own entry, moving no stock, and refuses a second review', async () => {
      const before = await balance(rice.id, StockLocation.KITCHEN);
      const mine = await log('manager', StockLocation.KITCHEN, rice.id, 3);

      const rejected = (
        await command('manager', mine, 'reject', {
          reason: 'Miscounted',
        }).expect(200)
      ).body as Waste;
      expect(rejected).toMatchObject({
        status: WasteStatus.REJECTED,
        decidedById: staffId.manager,
      });
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(before);

      const again = await command('manager2', rejected, 'approve').expect(409);
      expect(messageOf(again)).toBe(REVIEW_PENDING_WASTE_MESSAGE);
      await command('kitchen', rejected, 'reject').expect(403);
    });

    it('lets one of two managers approving at once win; the other sees the refresh message', async () => {
      const before = await balance(rice.id, StockLocation.KITCHEN);
      const entry = await log('kitchen', StockLocation.KITCHEN, rice.id, 1);

      const results = await Promise.all([
        command('manager', entry, 'approve'),
        command('manager2', entry, 'approve'),
      ]);
      const statuses = results.map((response) => response.status).sort();

      expect(statuses).toEqual([200, 409]);
      expect(
        messageOf(results.find((response) => response.status === 409)!),
      ).toBe(STALE_VERSION_MESSAGE);
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(before - 1);
      expect(
        await prisma.approvalLedger.count({ where: { ref: entry.number } }),
      ).toBe(1);
    });

    it('answers 404 for an id that names nothing, and the role sentence to anyone but a manager', async () => {
      const missing = await command(
        'manager',
        { id: 'missing', version: 0 },
        'approve',
      ).expect(404);
      expect(messageOf(missing)).toBe(WASTE_NOT_FOUND_MESSAGE);

      const entry = await log('kitchen', StockLocation.KITCHEN, rice.id, 1);

      for (const actor of ['kitchen', 'storekeeper', 'cashier'] as Actor[]) {
        const response = await command(actor, entry, 'approve').expect(403);
        expect(messageOf(response)).toBe(ROLE_REFUSED_MESSAGE);
      }
    });
  });

  describe('waste.edit and waste.status', () => {
    it('approved waste corrections and rejection restore exact quantities', async () => {
      const start = await balance(rice.id, StockLocation.KITCHEN);
      let entry = await log('kitchen', StockLocation.KITCHEN, rice.id, 2);
      entry = (await command('manager', entry, 'approve').expect(200))
        .body as Waste;
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(start - 2);

      entry = (
        await edit('manager', entry, {
          location: 'KITCHEN',
          stockItemId: rice.id,
          qty: 1,
          wasteReason: 'BURNT',
          reason: 'Correct count',
        }).expect(200)
      ).body as Waste;
      expect(entry).toMatchObject({
        qty: 1,
        reason: WasteReason.BURNT,
        valueKobo: RICE_BAG_KOBO / 50,
        status: WasteStatus.APPROVED,
      });
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(start - 1);

      entry = (
        await command('manager', entry, 'status', {
          status: 'REJECTED',
          reason: 'Not waste',
        }).expect(200)
      ).body as Waste;
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(start);

      const before = await stored(entry.id);
      const invalid = await edit('manager', entry, {
        location: 'KITCHEN',
        stockItemId: rice.id,
        qty: -1,
        wasteReason: 'BURNT',
        reason: 'Invalid',
      }).expect(400);
      expect(messageOf(invalid)).toBe(EDIT_QTY_REASON_MESSAGE);
      expect(await stored(entry.id)).toEqual(before);
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(start);

      const movements = await prisma.stockMovement.findMany({
        where: { ref: entry.number },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { qty: true, type: true },
      });
      expect(movements).toEqual([
        { qty: -2, type: StockMovementType.WASTE },
        { qty: 2, type: StockMovementType.WASTE_CORRECTION_RETURN },
        { qty: -1, type: StockMovementType.WASTE_CORRECTION_DEDUCTION },
        { qty: 1, type: StockMovementType.WASTE_APPROVAL_CORRECTION },
      ]);
      await expectLedgerHolds(rice.id, StockLocation.KITCHEN);
    });

    it('moves an approved entry to another location and item by returning one and taking the other', async () => {
      const riceBefore = await balance(rice.id, StockLocation.KITCHEN);
      const storeBefore = await balance(rice.id, StockLocation.STORE);
      let entry = await log('kitchen', StockLocation.KITCHEN, rice.id, 4);
      entry = (await command('manager', entry, 'approve').expect(200))
        .body as Waste;

      entry = (
        await edit('manager', entry, {
          location: 'STORE',
          stockItemId: rice.id,
          qty: 2,
          wasteReason: 'EXPIRED',
          note: 'Two bags, not four portions',
          reason: 'Wrong location',
        }).expect(200)
      ).body as Waste;

      expect(entry).toMatchObject({
        location: StockLocation.STORE,
        measure: 'bag',
        note: 'Two bags, not four portions',
        valueKobo: 2 * (RICE_BAG_KOBO / 50),
      });
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(riceBefore);
      expect(await balance(rice.id, StockLocation.STORE)).toBe(storeBefore - 2);
    });

    it('refuses a correction in the demo’s order, and holds the new value to the Owner Approval Limit', async () => {
      const entry = await log('kitchen', StockLocation.KITCHEN, rice.id, 1);
      const good = {
        location: 'KITCHEN',
        stockItemId: rice.id,
        qty: 1,
        wasteReason: 'BURNT',
        reason: 'Fix',
      };

      const cases: [Actor, Record<string, unknown>, number, string][] = [
        ['manager', { ...good, reason: ' ' }, 400, ADMIN_REASON_MESSAGE],
        ['manager', { ...good, location: 'ROOF' }, 400, EDIT_ITEM_MESSAGE],
        ['manager', { ...good, location: 'BAR' }, 400, EDIT_ITEM_MESSAGE],
        [
          'manager',
          { ...good, stockItemId: undefined, qty: 0 },
          400,
          EDIT_ITEM_MESSAGE,
        ],
        [
          'manager',
          { ...good, wasteReason: 'Burnt' },
          400,
          EDIT_QTY_REASON_MESSAGE,
        ],
        ['kitchen', good, 403, ROLE_REFUSED_MESSAGE],
        [
          'manager',
          {
            ...good,
            location: 'BAR',
            stockItemId: drink.id,
            qty: Math.floor(5_000_000 / drink.priceKobo) + 1,
          },
          403,
          approvalLimitMessage(LIMITED_DECISIONS.writeOff, 5_000_000),
        ],
      ];

      for (const [actor, body, status, message] of cases) {
        const response = await edit(actor, entry, body).expect(status);
        expect(sentencesOf(response)).toEqual([message]);
      }

      const missing = await edit(
        'manager',
        { id: 'missing', version: 0 },
        good,
      ).expect(404);
      expect(messageOf(missing)).toBe(WASTE_NOT_FOUND_MESSAGE);

      // A correction decides nothing: the Owner's is not limited, and no
      // manager's is counted toward the day.
      await edit('owner', entry, {
        ...good,
        location: 'BAR',
        stockItemId: drink.id,
        qty: Math.floor(5_000_000 / drink.priceKobo) + 1,
      }).expect(200);
      await edit('manager', { ...entry, version: 1 }, good).expect(200);
      expect(
        await prisma.approvalLedger.count({ where: { ref: entry.number } }),
      ).toBe(0);

      const stale = await edit('manager', entry, good).expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);
    });

    it('refuses a value its column cannot hold with the command’s sentence, never a 500', async () => {
      // A quantity within an Int whose value at the drink's price is not.
      const tooMany = Math.floor(INT4_MAX / drink.priceKobo) + 1;
      const bar = { location: 'BAR', stockItemId: drink.id };

      const created = await create('bartender', {
        ...bar,
        qty: tooMany,
        reason: 'SPILLED',
      }).expect(400);
      expect(sentencesOf(created)).toEqual([CREATE_QTY_REASON_MESSAGE]);

      const entry = await log('bartender', StockLocation.BAR, drink.id, 1);
      const edited = await edit('owner', entry, {
        ...bar,
        qty: tooMany,
        wasteReason: 'SPILLED',
        reason: 'Typo',
      }).expect(400);
      expect(sentencesOf(edited)).toEqual([EDIT_QTY_REASON_MESSAGE]);

      // A price raised after the entry was logged: valued afresh at the
      // decision, the approval cannot be recorded either, for the Owner too.
      const menuItemId = (
        await prisma.stockItem.findUniqueOrThrow({
          where: { id: drink.id },
          select: { menuItemId: true },
        })
      ).menuItemId!;
      const fits = await log(
        'bartender',
        StockLocation.BAR,
        drink.id,
        tooMany - 1,
      );

      await prisma.menuItem.update({
        where: { id: menuItemId },
        data: { priceKobo: drink.priceKobo * 2 },
      });

      try {
        for (const [path, body] of [
          ['approve', {}],
          ['status', { status: 'APPROVED', reason: 'Seen' }],
        ] as const) {
          const refused = await command('owner', fits, path, body).expect(409);
          expect(messageOf(refused)).toBe(WASTE_VALUE_TOO_LARGE_MESSAGE);
        }
      } finally {
        await prisma.menuItem.update({
          where: { id: menuItemId },
          data: { priceKobo: drink.priceKobo },
        });
      }

      expect((await stored(fits.id)).status).toBe(WasteStatus.PENDING);
    });

    it('applies the limits and the own-record rule when a status change approves, and moves stock both ways', async () => {
      const before = await balance(rice.id, StockLocation.KITCHEN);
      let entry = await log('kitchen', StockLocation.KITCHEN, rice.id, 5);

      entry = (await command('manager', entry, 'reject', {}).expect(200))
        .body as Waste;
      entry = (
        await command('manager2', entry, 'status', {
          status: 'APPROVED',
          reason: 'It was waste after all',
        }).expect(200)
      ).body as Waste;
      expect(entry).toMatchObject({
        status: WasteStatus.APPROVED,
        decidedById: staffId.manager2,
      });
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(before - 5);
      expect(
        await prisma.approvalLedger.count({
          where: { ref: entry.number, action: 'waste.status' },
        }),
      ).toBe(1);

      entry = (
        await command('manager2', entry, 'status', {
          status: 'PENDING',
          reason: 'Review again',
        }).expect(200)
      ).body as Waste;
      expect(entry).toMatchObject({
        status: WasteStatus.PENDING,
        decidedById: null,
      });
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(before);

      const bad = await command('manager2', entry, 'status', {
        status: 'DONE',
        reason: 'x',
      }).expect(400);
      expect(messageOf(bad)).toEqual([WASTE_STATUS_MESSAGE]);

      const noReason = await command('manager2', entry, 'status', {
        status: 'REJECTED',
      }).expect(400);
      expect(messageOf(noReason)).toEqual([ADMIN_REASON_MESSAGE]);

      const stale = await command(
        'manager2',
        { ...entry, version: entry.version - 1 },
        'status',
        { status: 'REJECTED', reason: 'x' },
      ).expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);
      await expectLedgerHolds(rice.id, StockLocation.KITCHEN);
    });
  });

  describe('the read and the history', () => {
    it('shows each role its own location’s waste, and managers every location', async () => {
      const kitchenEntry = await log(
        'kitchen',
        StockLocation.KITCHEN,
        rice.id,
        1,
      );
      const barEntry = await log('cashier', StockLocation.BAR, drink.id, 1);
      const storeEntry = await log(
        'storekeeper',
        StockLocation.STORE,
        rice.id,
        1,
      );

      const read = (actor: Actor, query: Record<string, unknown> = {}) =>
        request(server())
          .get('/api/v1/staff/waste')
          .query({ pageSize: 100, ...query })
          .set(as(actor));

      const locationsOf = async (actor: Actor) =>
        new Set(
          ((await read(actor).expect(200)).body as WastePage).data.map(
            (entry) => entry.location,
          ),
        );

      expect(await locationsOf('kitchen')).toEqual(
        new Set([StockLocation.KITCHEN]),
      );
      expect(await locationsOf('bartender')).toEqual(
        new Set([StockLocation.BAR]),
      );
      expect(await locationsOf('cashier')).toEqual(
        new Set([StockLocation.BAR]),
      );
      expect(await locationsOf('storekeeper')).toEqual(
        new Set([StockLocation.STORE]),
      );
      expect(await locationsOf('manager')).toEqual(
        new Set([
          StockLocation.KITCHEN,
          StockLocation.BAR,
          StockLocation.STORE,
        ]),
      );

      // Newest first, and the managers' location filter.
      const page = (await read('manager', { location: 'BAR' }).expect(200))
        .body as WastePage;
      expect(page.data[0].number).toBe(barEntry.number);
      expect(
        page.data.every((entry) => entry.location === StockLocation.BAR),
      ).toBe(true);

      // The views and the pending figure.
      const pending = (await read('kitchen', { view: 'PENDING' }).expect(200))
        .body as WastePage;
      expect(
        pending.data.every((entry) => entry.status === WasteStatus.PENDING),
      ).toBe(true);
      expect(pending.pendingCount).toBe(pending.total);
      const history = (await read('kitchen', { view: 'HISTORY' }).expect(200))
        .body as WastePage;
      expect(
        history.data.every((entry) => entry.status !== WasteStatus.PENDING),
      ).toBe(true);
      expect(history.pendingCount).toBe(pending.total);

      const found = (
        await read('manager', { q: storeEntry.number }).expect(200)
      ).body as WastePage;
      expect(found.data.map((entry) => entry.number)).toEqual([
        storeEntry.number,
      ]);

      const other = await read('kitchen', { location: 'BAR' }).expect(403);
      expect(messageOf(other)).toBe(ROLE_REFUSED_MESSAGE);
      await read('kitchen', { location: 'KITCHEN' }).expect(200);
      for (const actor of ['reception', 'waiter'] as Actor[]) {
        await read(actor).expect(403);
      }
      const badView = await read('manager', { view: 'SOON' }).expect(400);
      expect(messageOf(badView)).toEqual([WASTE_VIEW_MESSAGE]);

      expect(kitchenEntry.location).toBe(StockLocation.KITCHEN);
    });

    it('lets each logging role read the history of its own location’s entries, and no other', async () => {
      const entry = await log('kitchen', StockLocation.KITCHEN, rice.id, 1);
      await command('manager', entry, 'approve').expect(200);

      const history = (actor: Actor, ref: string = entry.number) =>
        request(server())
          .get('/api/v1/staff/audit')
          .query({ ref })
          .set(as(actor));

      const response = await history('kitchen').expect(200);
      expect(
        (response.body as { data: { action: string }[] }).data.map(
          (row) => row.action,
        ),
      ).toEqual(['waste.approve', 'waste.create']);

      for (const actor of [
        'bartender',
        'cashier',
        'storekeeper',
        'reception',
      ] as Actor[]) {
        await history(actor).expect(403);
      }

      await history('kitchen', 'W-999999999').expect(403);
    });
  });
});
