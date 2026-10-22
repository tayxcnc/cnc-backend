import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  MenuCategoryKind,
  StaffRole,
  StockKind,
  StockLocation,
  StockMovementType,
  StockRequestStatus,
} from '../generated/cnc-client';
import { BUSINESS } from '../prisma/seed-data/reference';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { IDEMPOTENCY_KEY_REQUIRED } from '../src/idempotency/idempotency-key.decorator';
import {
  OWN_RECORD_KINDS,
  ownRecordMessage,
} from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import {
  insufficientStockMessage,
  ISSUE_ITEM_MESSAGE,
  ISSUE_LOCATION_MESSAGE,
  issueWithinRequestMessage,
  REJECT_REASON_MESSAGE,
  REQUEST_NOT_OPEN_MESSAGE,
  REQUEST_QTY_MESSAGE,
  STOCK_REQUEST_NOT_FOUND_MESSAGE,
} from '../src/stock/stock-messages';
import { createTestApp } from './create-test-app';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * Stock requests (C5-2) through HTTP and against Postgres: the Kitchen and
 * the Bar ask the Store for whole packs, the Storekeeper issues them (Store
 * −packs, the location +packs × How Many in One) or declines them, and the
 * reads and the request history follow plan §6.1. The demo's request cases
 * (`stock.test.cjs`, `domain.test.cjs`, `owner.test.cjs`) are ported here
 * by name, and so is the C5 gate's step 4.
 *
 * Every item, drink and account is run-unique and never removed; the suite
 * never touches a seeded stock item. Opening balances are recorded by the
 * Owner's stock count, as the C4 gate records them.
 */
describe('Stock requests (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  const token: Partial<Record<StaffRole, string>> = {};
  const staffId: Partial<Record<StaffRole, string>> = {};
  let secondManagerToken: string;
  const tag = randomUUID().slice(0, 8);

  /** A run-unique Bar drink's paired stock item (batch of 12 servings). */
  let barStockId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);

    // The settings row the money controls read, and the business row, if no
    // seed has run on this database; never changed if present.
    await prisma.settings.createMany({ data: [{}], skipDuplicates: true });
    await prisma.business.createMany({
      data: [{ ...BUSINESS, addressLines: [...BUSINESS.addressLines] }],
      skipDuplicates: true,
    });

    const tokens = app.get(CncTokenService, { strict: false });

    for (const role of [
      StaffRole.OWNER,
      StaffRole.MANAGER,
      StaffRole.STOREKEEPER,
      StaffRole.KITCHEN,
      StaffRole.BARTENDER,
      StaffRole.CASHIER,
      StaffRole.WAITER,
    ]) {
      const account = await createStaffAccount(prisma, role, {
        emailPrefix: 'requests',
        name: `Requests ${role.toLowerCase()} ${tag}`,
      });
      staffId[role] = account.id;
      token[role] = await accessTokenFor(tokens, account.id);
    }

    const second = await createStaffAccount(prisma, StaffRole.MANAGER, {
      emailPrefix: 'requests',
      name: `Requests second manager ${tag}`,
    });
    secondManagerToken = await accessTokenFor(tokens, second.id);

    const menuCategory = await prisma.menuCategory.create({
      data: {
        slug: `requests-drinks-${tag}`,
        title: `Requests Drinks ${tag}`,
        kind: MenuCategoryKind.DRINKS,
        sort: 900,
      },
    });
    const staffCategory = await prisma.staffCategory.create({
      data: {
        name: `Requests Bar ${tag}`,
        department: Department.BAR,
        menuCategoryId: menuCategory.id,
      },
    });
    const drink = await prisma.menuItem.create({
      data: {
        slug: `requests-drink-${tag}`,
        department: Department.BAR,
        staffCategoryId: staffCategory.id,
        menuCategoryId: menuCategory.id,
        name: `Requests Drink ${tag}`,
        priceKobo: 250000,
      },
    });
    barStockId = (
      await prisma.stockItem.create({
        data: {
          name: `Requests Drink ${tag}`,
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

  interface StockRequest {
    id: string;
    number: string;
    location: StockLocation;
    stockItemId: string;
    qtyPacks: number;
    issuedPacks: number;
    remainingPacks: number;
    status: StockRequestStatus;
    note: string;
    rejectReason: string | null;
    createdById: string;
    createdByName: string;
    version: number;
  }

  interface RequestPage {
    data: StockRequest[];
    total: number;
    openCount: number;
  }

  /** A new run-unique Kitchen item, made through the route by a manager. */
  async function kitchenItem(
    pack = 'tray',
    factor = 10,
  ): Promise<{ id: string; name: string }> {
    const response = await request(server())
      .post('/api/v1/staff/stock/items')
      .set(auth(StaffRole.MANAGER))
      .send({
        name: `Requests Portion ${randomUUID()}`,
        unit: 'portion',
        pack,
        factor,
        minimum: 15,
      })
      .expect(201);

    return response.body as { id: string; name: string };
  }

  /** The Owner records an opening balance by stock count. */
  async function opening(
    stockItemId: string,
    location: StockLocation,
    counted: number,
  ): Promise<void> {
    await request(server())
      .post('/api/v1/staff/stock/counts')
      .set(auth(StaffRole.OWNER))
      .set('Idempotency-Key', randomUUID())
      .send({ location, counts: [{ stockItemId, counted }] })
      .expect(201);
  }

  /** A balance straight from the table (a missing row is zero). */
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

  /** The balance must equal the sum of the item's movements there. */
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

  const create = (
    role: StaffRole,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) =>
    request(server())
      .post('/api/v1/staff/stock/requests')
      .set(auth(role))
      .set('Idempotency-Key', key)
      .send(body);

  /** A request raised through the route, expected to succeed. */
  async function raise(
    role: StaffRole,
    body: Record<string, unknown>,
  ): Promise<StockRequest> {
    return (await create(role, body).expect(201)).body as StockRequest;
  }

  const issue = (
    role: StaffRole,
    target: { id: string; version: number },
    qty: unknown,
  ) =>
    request(server())
      .post(`/api/v1/staff/stock/requests/${target.id}/issue`)
      .set(auth(role))
      .send({ version: target.version, qty });

  const reject = (
    role: StaffRole,
    target: { id: string; version: number },
    reason?: string,
  ) =>
    request(server())
      .post(`/api/v1/staff/stock/requests/${target.id}/reject`)
      .set(auth(role))
      .send({ version: target.version, ...(reason ? { reason } : {}) });

  const list = (role: StaffRole, query: Record<string, string> = {}) =>
    request(server())
      .get('/api/v1/staff/stock/requests')
      .query(query)
      .set(auth(role));

  describe('request.create and request.issue', () => {
    it('kitchen requests whole purchase units and the store issues them as portions (the C5 gate, step 4: Store −2, Kitchen +100)', async () => {
      const rice = await kitchenItem('bag', 50);
      await opening(rice.id, StockLocation.STORE, 5);

      const asked = await raise(StaffRole.KITCHEN, {
        stockItemId: rice.id,
        qty: 2,
        note: 'Dinner preparation',
      });

      expect(asked).toMatchObject({
        location: StockLocation.KITCHEN,
        stockItemId: rice.id,
        qtyPacks: 2,
        issuedPacks: 0,
        remainingPacks: 2,
        status: StockRequestStatus.PENDING,
        note: 'Dinner preparation',
        rejectReason: null,
        createdById: staffId[StaffRole.KITCHEN],
        createdByName: `Requests kitchen ${tag}`,
        version: 0,
      });
      expect(asked.number).toMatch(/^SR-\d{6,}$/);

      const half = await issue(StaffRole.STOREKEEPER, asked, 1.5).expect(400);
      expect(messageOf(half)).toBe(
        'Enter a whole number of bags within the remaining request.',
      );

      const sent = await issue(StaffRole.STOREKEEPER, asked, 2).expect(200);
      expect(sent.body).toMatchObject({
        packs: 2,
        units: 100,
        storeQty: 3,
        destinationQty: 100,
        request: {
          id: asked.id,
          issuedPacks: 2,
          remainingPacks: 0,
          status: StockRequestStatus.ISSUED,
          version: 1,
        },
      });
      expect(await balance(rice.id, StockLocation.STORE)).toBe(3);
      expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(100);

      const moves = await prisma.stockMovement.findMany({
        where: { stockItemId: rice.id, ref: asked.number },
        select: { location: true, qty: true, type: true, staffId: true },
      });
      expect(moves).toEqual(
        expect.arrayContaining([
          {
            location: StockLocation.STORE,
            qty: -2,
            type: StockMovementType.ISSUE_TO_KITCHEN,
            staffId: staffId[StaffRole.STOREKEEPER],
          },
          {
            location: StockLocation.KITCHEN,
            qty: 100,
            type: StockMovementType.STOCK_RECEIVED,
            staffId: staffId[StaffRole.STOREKEEPER],
          },
        ]),
      );
      expect(moves).toHaveLength(2);
      await expectLedgerHolds(rice.id, StockLocation.STORE);
      await expectLedgerHolds(rice.id, StockLocation.KITCHEN);

      const entries = await prisma.auditLog.findMany({
        where: { ref: asked.number },
        orderBy: { at: 'asc' },
        select: { action: true, module: true, staffId: true },
      });
      expect(entries).toEqual([
        {
          action: 'request.create',
          module: 'Stock & Requests',
          staffId: staffId[StaffRole.KITCHEN],
        },
        {
          action: 'request.issue',
          module: 'Stock & Requests',
          staffId: staffId[StaffRole.STOREKEEPER],
        },
      ]);
    });

    it('stock request partial issues convert store packs and complete once', async () => {
      await opening(barStockId, StockLocation.STORE, 4);
      const barBefore = await balance(barStockId, StockLocation.BAR);
      const storeBefore = await balance(barStockId, StockLocation.STORE);

      const asked = await raise(StaffRole.BARTENDER, {
        stockItemId: barStockId,
        qty: 2,
      });
      expect(asked.location).toBe(StockLocation.BAR);

      const first = await issue(StaffRole.STOREKEEPER, asked, 1).expect(200);
      const afterFirst = (first.body as { request: StockRequest }).request;
      expect(afterFirst).toMatchObject({
        issuedPacks: 1,
        remainingPacks: 1,
        status: StockRequestStatus.PARTIALLY_ISSUED,
      });
      expect(await balance(barStockId, StockLocation.STORE)).toBe(
        storeBefore - 1,
      );
      expect(await balance(barStockId, StockLocation.BAR)).toBe(barBefore + 12);

      const more = await issue(StaffRole.STOREKEEPER, afterFirst, 2).expect(
        400,
      );
      expect(messageOf(more)).toBe(issueWithinRequestMessage('batch'));

      const second = await issue(StaffRole.STOREKEEPER, afterFirst, 1).expect(
        200,
      );
      const done = (second.body as { request: StockRequest }).request;
      expect(done.status).toBe(StockRequestStatus.ISSUED);
      expect(await balance(barStockId, StockLocation.BAR)).toBe(barBefore + 24);

      const again = await issue(StaffRole.STOREKEEPER, done, 1).expect(409);
      expect(messageOf(again)).toBe(REQUEST_NOT_OPEN_MESSAGE);
      await expectLedgerHolds(barStockId, StockLocation.STORE);
      await expectLedgerHolds(barStockId, StockLocation.BAR);
    });

    it('a manager cannot issue a stock request they raised; another manager, the storekeeper and the Owner can', async () => {
      await opening(barStockId, StockLocation.STORE, 10);

      const own = await raise(StaffRole.MANAGER, {
        location: StockLocation.BAR,
        stockItemId: barStockId,
        qty: 2,
      });
      expect(own.createdById).toBe(staffId[StaffRole.MANAGER]);

      const refused = await issue(StaffRole.MANAGER, own, 1).expect(403);
      expect(messageOf(refused)).toBe(
        ownRecordMessage(OWN_RECORD_KINDS.stockRequest),
      );
      expect(messageOf(refused)).toBe(
        'You cannot approve a stock request you created. The Owner or another manager must approve it.',
      );

      const byStore = await issue(StaffRole.STOREKEEPER, own, 1).expect(200);
      const partly = (byStore.body as { request: StockRequest }).request;
      await request(server())
        .post(`/api/v1/staff/stock/requests/${own.id}/issue`)
        .set({ Authorization: `Bearer ${secondManagerToken}` })
        .send({ version: partly.version, qty: 1 })
        .expect(200);

      const ownersOwn = await raise(StaffRole.OWNER, {
        location: StockLocation.BAR,
        stockItemId: barStockId,
        qty: 1,
      });
      const byOwner = await issue(StaffRole.OWNER, ownersOwn, 1).expect(200);
      expect((byOwner.body as { request: StockRequest }).request.status).toBe(
        StockRequestStatus.ISSUED,
      );
    });

    it('cashiers can request bar stock, and only bar stock', async () => {
      const kitchenOnly = await kitchenItem();

      const bar = await raise(StaffRole.CASHIER, {
        location: StockLocation.KITCHEN,
        stockItemId: barStockId,
        qty: 1,
      });
      expect(bar.location).toBe(StockLocation.BAR);

      const food = await create(StaffRole.CASHIER, {
        stockItemId: kitchenOnly.id,
        qty: 1,
      }).expect(400);
      expect(messageOf(food)).toBe(ISSUE_ITEM_MESSAGE);
      expect(messageOf(food)).toMatch(/this stock location/);
    });

    it('lets only the Kitchen, the Bar, the Cashier and managers ask, and only the storekeeper and managers issue or decline', async () => {
      for (const role of [StaffRole.STOREKEEPER, StaffRole.WAITER]) {
        const response = await create(role, {
          stockItemId: barStockId,
          qty: 1,
        }).expect(403);
        expect(messageOf(response)).toBe(ROLE_REFUSED_MESSAGE);
      }

      const asked = await raise(StaffRole.BARTENDER, {
        stockItemId: barStockId,
        qty: 1,
      });

      for (const role of [
        StaffRole.KITCHEN,
        StaffRole.BARTENDER,
        StaffRole.CASHIER,
      ]) {
        expect(messageOf(await issue(role, asked, 1).expect(403))).toBe(
          ROLE_REFUSED_MESSAGE,
        );
        expect(messageOf(await reject(role, asked, 'No').expect(403))).toBe(
          ROLE_REFUSED_MESSAGE,
        );
      }
    });

    it('refuses a manager’s request with no location or the Store, packs that are not whole, and an item the location does not hold', async () => {
      const kitchenOnly = await kitchenItem();

      const none = await create(StaffRole.MANAGER, {
        stockItemId: kitchenOnly.id,
        qty: 1,
      }).expect(400);
      expect(messageOf(none)).toBe(ISSUE_LOCATION_MESSAGE);

      const store = await create(StaffRole.MANAGER, {
        location: StockLocation.STORE,
        stockItemId: kitchenOnly.id,
        qty: 1,
      }).expect(400);
      expect(messageOf(store)).toBe(ISSUE_LOCATION_MESSAGE);

      for (const qty of [0, 1.5, -2, '2']) {
        const response = await create(StaffRole.KITCHEN, {
          stockItemId: kitchenOnly.id,
          qty,
        }).expect(400);
        expect(messageOf(response)).toEqual([REQUEST_QTY_MESSAGE]);
      }

      const barForKitchen = await create(StaffRole.KITCHEN, {
        stockItemId: barStockId,
        qty: 1,
      }).expect(400);
      expect(messageOf(barForKitchen)).toBe(ISSUE_ITEM_MESSAGE);

      const unknown = await create(StaffRole.KITCHEN, {
        stockItemId: randomUUID(),
        qty: 1,
      }).expect(400);
      expect(messageOf(unknown)).toBe(ISSUE_ITEM_MESSAGE);
    });

    it('refuses an issue the Store cannot cover and changes nothing', async () => {
      const item = await kitchenItem();
      await opening(item.id, StockLocation.STORE, 1);
      const asked = await raise(StaffRole.KITCHEN, {
        stockItemId: item.id,
        qty: 2,
      });

      const short = await issue(StaffRole.STOREKEEPER, asked, 2).expect(409);
      expect(messageOf(short)).toBe(
        insufficientStockMessage(StockLocation.STORE, item.name),
      );

      const after = await prisma.stockRequest.findUniqueOrThrow({
        where: { id: asked.id },
      });
      expect(after).toMatchObject({
        issuedPacks: 0,
        status: StockRequestStatus.PENDING,
        version: 0,
      });
      expect(await balance(item.id, StockLocation.STORE)).toBe(1);
      expect(await balance(item.id, StockLocation.KITCHEN)).toBe(0);
    });

    it('needs an Idempotency-Key to ask, and a retry with the same key asks once', async () => {
      const body = { stockItemId: barStockId, qty: 3 };

      const missing = await request(server())
        .post('/api/v1/staff/stock/requests')
        .set(auth(StaffRole.BARTENDER))
        .send(body)
        .expect(400);
      expect(messageOf(missing)).toBe(IDEMPOTENCY_KEY_REQUIRED);

      const key = randomUUID();
      const first = await create(StaffRole.BARTENDER, body, key).expect(201);
      const replay = await create(StaffRole.BARTENDER, body, key).expect(201);

      expect(replay.body).toEqual(first.body);
      expect(
        await prisma.stockRequest.count({
          where: { number: (first.body as StockRequest).number },
        }),
      ).toBe(1);
    });

    it('refuses a stale version and an unknown request', async () => {
      await opening(barStockId, StockLocation.STORE, 10);
      const asked = await raise(StaffRole.BARTENDER, {
        stockItemId: barStockId,
        qty: 2,
      });
      await issue(StaffRole.STOREKEEPER, asked, 1).expect(200);

      const stale = await issue(StaffRole.STOREKEEPER, asked, 1).expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);

      const staleReject = await reject(
        StaffRole.STOREKEEPER,
        asked,
        'Late',
      ).expect(409);
      expect(messageOf(staleReject)).toBe(STALE_VERSION_MESSAGE);

      const missing = await issue(
        StaffRole.STOREKEEPER,
        { id: randomUUID(), version: 0 },
        1,
      ).expect(404);
      expect(messageOf(missing)).toBe(STOCK_REQUEST_NOT_FOUND_MESSAGE);
    });

    it('lets two issues of one request race and only one send its packs', async () => {
      await opening(barStockId, StockLocation.STORE, 10);
      const asked = await raise(StaffRole.BARTENDER, {
        stockItemId: barStockId,
        qty: 2,
      });
      const storeBefore = await balance(barStockId, StockLocation.STORE);

      const results = await Promise.all(
        [0, 1].map(() => issue(StaffRole.STOREKEEPER, asked, 2)),
      );

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(messageOf(results.find((r) => r.status === 409)!)).toBe(
        STALE_VERSION_MESSAGE,
      );
      expect(await balance(barStockId, StockLocation.STORE)).toBe(
        storeBefore - 2,
      );
      expect(
        await prisma.stockMovement.count({ where: { ref: asked.number } }),
      ).toBe(2);
    });
  });

  describe('request.reject', () => {
    it('declines with a reason, moves nothing, and closes the request', async () => {
      const asked = await raise(StaffRole.BARTENDER, {
        stockItemId: barStockId,
        qty: 2,
      });

      const blank = await reject(StaffRole.STOREKEEPER, asked, '  ').expect(
        400,
      );
      expect(messageOf(blank)).toEqual([REJECT_REASON_MESSAGE]);
      const none = await reject(StaffRole.STOREKEEPER, asked).expect(400);
      expect(messageOf(none)).toEqual([REJECT_REASON_MESSAGE]);

      const declined = await reject(
        StaffRole.STOREKEEPER,
        asked,
        'Out until Friday',
      ).expect(200);
      const body = declined.body as StockRequest;
      expect(body).toMatchObject({
        status: StockRequestStatus.REJECTED,
        rejectReason: 'Out until Friday',
        remainingPacks: 0,
        version: 1,
      });
      expect(
        await prisma.stockMovement.count({ where: { ref: asked.number } }),
      ).toBe(0);

      const entry = await prisma.auditLog.findFirst({
        where: { ref: asked.number, action: 'request.reject' },
        select: { reason: true },
      });
      expect(entry?.reason).toBe('Out until Friday');

      expect(
        messageOf(await issue(StaffRole.STOREKEEPER, body, 1).expect(409)),
      ).toBe(REQUEST_NOT_OPEN_MESSAGE);
      expect(
        messageOf(
          await reject(StaffRole.STOREKEEPER, body, 'Again').expect(409),
        ),
      ).toBe(REQUEST_NOT_OPEN_MESSAGE);
    });

    it('declines what is left of a partly issued request and keeps what was sent', async () => {
      await opening(barStockId, StockLocation.STORE, 10);
      const asked = await raise(StaffRole.BARTENDER, {
        stockItemId: barStockId,
        qty: 3,
      });
      const partly = (
        (await issue(StaffRole.STOREKEEPER, asked, 1).expect(200)).body as {
          request: StockRequest;
        }
      ).request;

      const declined = await reject(
        StaffRole.MANAGER,
        partly,
        'Enough for tonight',
      ).expect(200);

      expect(declined.body).toMatchObject({
        status: StockRequestStatus.REJECTED,
        issuedPacks: 1,
        remainingPacks: 0,
      });
    });
  });

  describe('reads', () => {
    let kitchenRequest: StockRequest;
    let barRequest: StockRequest;

    beforeAll(async () => {
      const item = await kitchenItem();
      kitchenRequest = await raise(StaffRole.KITCHEN, {
        stockItemId: item.id,
        qty: 1,
      });
      barRequest = await raise(StaffRole.BARTENDER, {
        stockItemId: barStockId,
        qty: 1,
      });
    });

    const numbers = (response: request.Response) =>
      (response.body as RequestPage).data.map((row) => row.number);

    it('shows the Kitchen its requests, the Bar its own, and the storekeeper and managers both', async () => {
      const kitchen = await list(StaffRole.KITCHEN, {
        q: kitchenRequest.number,
      }).expect(200);
      expect(numbers(kitchen)).toEqual([kitchenRequest.number]);
      expect(
        numbers(
          await list(StaffRole.KITCHEN, { q: barRequest.number }).expect(200),
        ),
      ).toEqual([]);

      const bar = await list(StaffRole.BARTENDER, {
        q: barRequest.number,
      }).expect(200);
      expect(numbers(bar)).toEqual([barRequest.number]);
      expect(
        (bar.body as RequestPage).data.every(
          (row) => row.location === StockLocation.BAR,
        ),
      ).toBe(true);

      for (const role of [StaffRole.STOREKEEPER, StaffRole.MANAGER]) {
        expect(
          numbers(await list(role, { q: kitchenRequest.number }).expect(200)),
        ).toEqual([kitchenRequest.number]);
        expect(
          numbers(await list(role, { q: barRequest.number }).expect(200)),
        ).toEqual([barRequest.number]);
      }

      const kitchenOnly = await list(StaffRole.STOREKEEPER, {
        location: StockLocation.KITCHEN,
        q: barRequest.number,
      }).expect(200);
      expect(numbers(kitchenOnly)).toEqual([]);
    });

    it('refuses the other location to a scoped role, and the read to roles without the page', async () => {
      const kitchen = await list(StaffRole.KITCHEN, {
        location: StockLocation.BAR,
      }).expect(403);
      expect(messageOf(kitchen)).toBe(ROLE_REFUSED_MESSAGE);

      for (const role of [StaffRole.CASHIER, StaffRole.WAITER]) {
        expect(messageOf(await list(role).expect(403))).toBe(
          ROLE_REFUSED_MESSAGE,
        );
      }

      const store = await list(StaffRole.STOREKEEPER, {
        location: StockLocation.STORE,
      }).expect(400);
      expect(messageOf(store)).toEqual([ISSUE_LOCATION_MESSAGE]);
    });

    it('filters by status, searches item names, pages newest first, and counts the open requests', async () => {
      const issued = await list(StaffRole.STOREKEEPER, {
        status: StockRequestStatus.ISSUED,
        pageSize: '100',
      }).expect(200);
      expect(
        (issued.body as RequestPage).data.every(
          (row) => row.status === StockRequestStatus.ISSUED,
        ),
      ).toBe(true);

      const byName = await list(StaffRole.BARTENDER, {
        q: `requests drink ${tag}`,
        pageSize: '100',
      }).expect(200);
      const page = byName.body as RequestPage;
      expect(page.data.map((row) => row.number)).toContain(barRequest.number);
      expect(page.total).toBeGreaterThanOrEqual(page.data.length);

      const created = page.data.map((row) => row.number);
      const fromDb = await prisma.stockRequest.findMany({
        where: { number: { in: created } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { number: true },
      });
      expect(created).toEqual(fromDb.map((row) => row.number));

      const open = await list(StaffRole.KITCHEN).expect(200);
      const openInDb = await prisma.stockRequest.count({
        where: {
          location: StockLocation.KITCHEN,
          status: {
            in: [
              StockRequestStatus.PENDING,
              StockRequestStatus.PARTIALLY_ISSUED,
            ],
          },
        },
      });
      expect((open.body as RequestPage).openCount).toBe(openInDb);

      expect(
        messageOf(
          await list(StaffRole.STOREKEEPER, { status: 'DONE' }).expect(400),
        ),
      ).toEqual(['Choose a request status.']);
    });

    it('lets the storekeeper and the request’s own location read its history, and nobody else but managers', async () => {
      const history = (role: StaffRole, ref: string) =>
        request(server())
          .get('/api/v1/staff/audit')
          .query({ ref })
          .set(auth(role));

      for (const role of [StaffRole.KITCHEN, StaffRole.STOREKEEPER]) {
        const response = await history(role, kitchenRequest.number).expect(200);
        expect(
          (response.body as { data: { action: string }[] }).data.map(
            (row) => row.action,
          ),
        ).toEqual(['request.create']);
      }

      for (const role of [StaffRole.BARTENDER, StaffRole.CASHIER]) {
        await history(role, kitchenRequest.number).expect(403);
      }

      await history(StaffRole.BARTENDER, barRequest.number).expect(200);
      await history(StaffRole.KITCHEN, barRequest.number).expect(403);
      await history(StaffRole.STOREKEEPER, 'SR-999999999').expect(403);
      await history(StaffRole.MANAGER, kitchenRequest.number).expect(200);
    });
  });
});
