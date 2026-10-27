import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  PurchaseStatus,
  StaffRole,
  StockLocation,
  StockMovementType,
  WasteReason,
  WasteStatus,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { APPROVAL_VIEW_MESSAGE } from '../src/approvals/approvals-messages';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import {
  approvalLimitMessage,
  dailyLimitMessage,
  LIMITED_DECISIONS,
  OWN_RECORD_KINDS,
  ownRecordMessage,
} from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { StockLedgerService } from '../src/stock/stock-ledger.service';
import { createTestApp } from './create-test-app';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { readBell } from './staff-bell';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * The Approvals read (card C5-8) through HTTP and against Postgres: what
 * awaits whom, the prediction checked against the approve routes' real
 * answers, the views and search, and the races where two managers decide
 * the same requisition or waste entry at once. The demo's "manager bell
 * contains pending approvals and removes each when it is resolved"
 * (`attendance.test.cjs`) is ported onto this read and, from C8-2, onto
 * the bell's Approval items, each command driven through its route.
 *
 * It runs on a database of its own (`createIsolatedDatabase`) because its
 * counts are over every pending record at CNC, and its daily totals need
 * managers no other suite has spent. The limits are the seeded ₦50,000
 * and ₦150,000.
 */
describe('Approvals (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  const originalUrl = process.env.CNC_DB_URL;

  type Actor =
    | 'owner'
    | 'manager'
    | 'manager2'
    | 'manager3'
    | 'manager4'
    | 'manager5'
    | 'storekeeper'
    | 'kitchen'
    | 'waiter';

  const ROLE: Record<Actor, StaffRole> = {
    owner: StaffRole.OWNER,
    manager: StaffRole.MANAGER,
    manager2: StaffRole.MANAGER,
    manager3: StaffRole.MANAGER,
    manager4: StaffRole.MANAGER,
    manager5: StaffRole.MANAGER,
    storekeeper: StaffRole.STOREKEEPER,
    kitchen: StaffRole.KITCHEN,
    waiter: StaffRole.WAITER,
  };

  const staffId: Partial<Record<Actor, string>> = {};
  const token: Partial<Record<Actor, string>> = {};

  interface Awaiting {
    awaits: 'MANAGER' | 'OWNER';
    valueKobo: number;
    readerMayApprove: boolean;
    refusal: string | null;
  }

  interface Purchase {
    id: string;
    number: string;
    status: PurchaseStatus;
    totalKobo: number;
    vendorName: string;
    lines: { vendorId: string; vendorName: string }[];
    awaiting?: Awaiting | null;
    version: number;
  }

  interface Waste {
    id: string;
    number: string;
    status: WasteStatus;
    valueKobo: number;
    stockItemName: string;
    awaiting?: Awaiting | null;
    version: number;
  }

  interface Approvals {
    view: 'PENDING' | 'HISTORY';
    purchases: { data: Purchase[]; total: number };
    waste: { data: Waste[]; total: number };
    counts: { pendingPurchases: number; pendingWaste: number };
    standing: {
      approvalLimitKobo: number;
      dailyLimitOn: boolean;
      dailyLimitKobo: number;
      approvedTodayKobo: number;
    };
  }

  let vendor: { id: string; name: string };
  /** Steak: ₦40,000 a carton of one, so one written off is ₦40,000. */
  let steak: { id: string; name: string };
  /** Rice: ₦70,000 a bag of 50. */
  let rice: { id: string; name: string };

  const STEAK_KOBO = 4_000_000;
  const RICE_BAG_KOBO = 7_000_000;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    const ledger = app.get(StockLedgerService, { strict: false });
    const tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);

    for (const actor of Object.keys(ROLE) as Actor[]) {
      const account = await createStaffAccount(prisma, ROLE[actor], {
        emailPrefix: 'approvals',
        name: `Approvals ${actor}`,
      });
      staffId[actor] = account.id;
      token[actor] = await accessTokenFor(tokens, account.id);
    }

    vendor = (
      await request(server())
        .post('/api/v1/staff/vendors')
        .set(as('storekeeper'))
        .set('Idempotency-Key', randomUUID())
        .send({
          name: 'Approvals Foods',
          service: 'Food',
          phone: '08000000030',
        })
        .expect(201)
    ).body as { id: string; name: string };

    steak = await kitchenItem('Approvals Steak', 'carton', 1);
    rice = await kitchenItem('Approvals Rice', 'bag', 50);

    // The pack costs, from a requisition the Owner approves so that it is
    // not left awaiting a decision.
    const costs = await raise([
      { stockItemId: steak.id, qty: 1, costKobo: STEAK_KOBO },
      { stockItemId: rice.id, qty: 1, costKobo: RICE_BAG_KOBO },
    ]);
    await decide('owner', 'purchases', costs, 'approve').expect(200);

    await prisma.$transaction(async (tx) => {
      await ledger.move(tx, {
        stockItemId: steak.id,
        location: StockLocation.KITCHEN,
        qty: 200,
        type: StockMovementType.STOCK_COUNT,
        ref: 'Opening balance',
        staffId: null,
      });
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

  async function kitchenItem(
    name: string,
    pack: string,
    factor: number,
  ): Promise<{ id: string; name: string }> {
    return (
      await request(server())
        .post('/api/v1/staff/stock/items')
        .set(as('manager'))
        .send({ name, unit: 'portion', pack, factor, minimum: 15 })
        .expect(201)
    ).body as { id: string; name: string };
  }

  async function raise(
    lines: Record<string, unknown>[],
    actor: Actor = 'storekeeper',
  ): Promise<Purchase> {
    return (
      await request(server())
        .post('/api/v1/staff/purchases')
        .set(as(actor))
        .set('Idempotency-Key', randomUUID())
        .send({ vendorId: vendor.id, lines })
        .expect(201)
    ).body as Purchase;
  }

  /** `cartons` cartons of steak, raised by the Storekeeper. */
  const steakPurchase = (cartons: number, costKobo = STEAK_KOBO) =>
    raise([{ stockItemId: steak.id, qty: cartons, costKobo }]);

  async function logWaste(actor: Actor, qty = 1): Promise<Waste> {
    return (
      await request(server())
        .post('/api/v1/staff/waste')
        .set(as(actor))
        .set('Idempotency-Key', randomUUID())
        .send({
          location: StockLocation.KITCHEN,
          stockItemId: steak.id,
          qty,
          reason: WasteReason.SPOILED,
        })
        .expect(201)
    ).body as Waste;
  }

  const decide = (
    actor: Actor,
    kind: 'purchases' | 'waste',
    target: { id: string; version: number },
    path: 'approve' | 'reject',
  ) =>
    request(server())
      .post(`/api/v1/staff/${kind}/${target.id}/${path}`)
      .set(as(actor))
      .send({ version: target.version });

  const approvals = (actor: Actor, query: Record<string, string> = {}) =>
    request(server())
      .get('/api/v1/staff/approvals')
      .query({ pageSize: '100', ...query })
      .set(as(actor));

  async function read(
    actor: Actor,
    query: Record<string, string> = {},
  ): Promise<Approvals> {
    return (await approvals(actor, query).expect(200)).body as Approvals;
  }

  /** Every pending record, decided by the Owner, so a test starts clean. */
  async function clearPending(): Promise<void> {
    const pending = await read('owner');

    for (const purchase of pending.purchases.data) {
      await decide('owner', 'purchases', purchase, 'reject').expect(200);
    }

    for (const entry of pending.waste.data) {
      await decide('owner', 'waste', entry, 'reject').expect(200);
    }
  }

  it('manager bell contains pending approvals and removes each when it is resolved (attendance.test.cjs, on the approvals read and the bell)', async () => {
    const waste = await logWaste('kitchen');
    const purchase = await steakPurchase(1);
    /** The reader's bell items of the demo's `category === 'Approval'`. */
    const approvalItems = async (actor: Actor) =>
      (await readBell(server(), as(actor))).data
        .filter((item) => item.category === 'Approval')
        .map((item) => item.id);

    let desk = await read('manager');
    expect(desk.counts).toEqual({ pendingPurchases: 1, pendingWaste: 1 });
    expect(desk.purchases.data.map((p) => p.number)).toEqual([purchase.number]);
    expect(desk.waste.data.map((w) => w.number)).toEqual([waste.number]);
    expect(await approvalItems('manager')).toEqual([
      `purchase:${purchase.id}`,
      `waste:${waste.id}`,
    ]);

    // The demo's other half: no other role is asked to approve.
    for (const actor of ['storekeeper', 'kitchen', 'waiter'] as const) {
      expect({ actor, items: await approvalItems(actor) }).toEqual({
        actor,
        items: [],
      });
    }

    await decide('manager', 'waste', desk.waste.data[0], 'approve').expect(200);
    desk = await read('manager');
    expect(desk.counts).toEqual({ pendingPurchases: 1, pendingWaste: 0 });
    expect(desk.waste.data).toEqual([]);
    expect(await approvalItems('manager')).toEqual([`purchase:${purchase.id}`]);

    await decide(
      'owner',
      'purchases',
      desk.purchases.data[0],
      'approve',
    ).expect(200);
    desk = await read('manager');
    expect(desk.counts).toEqual({ pendingPurchases: 0, pendingWaste: 0 });
    expect(desk.purchases.data).toEqual([]);
    expect(await approvalItems('manager')).toEqual([]);

    // Both are now in History, decided, with nothing awaited.
    const history = await read('manager', { view: 'HISTORY' });
    expect(history.view).toBe('HISTORY');
    expect(history.purchases.data[0]).toMatchObject({
      number: purchase.number,
      status: PurchaseStatus.APPROVED,
      awaiting: null,
    });
    expect(history.waste.data[0]).toMatchObject({
      number: waste.number,
      status: WasteStatus.APPROVED,
      awaiting: null,
    });
  });

  it('shows what awaits whom, and each refusal it predicts is the approve route’s own', async () => {
    // ₦140,000: above the Owner Approval Limit.
    const big = await raise([
      { stockItemId: rice.id, qty: 2, costKobo: RICE_BAG_KOBO },
    ]);
    // ₦40,000, raised by the Storekeeper.
    const small = await steakPurchase(1);
    // ₦40,000, logged by a manager.
    const own = await logWaste('manager2');

    const desk = await read('manager2');
    expect(desk.view).toBe('PENDING');
    // Oldest first: the queue in the order it was raised.
    expect(desk.purchases.data.map((p) => p.number)).toEqual([
      big.number,
      small.number,
    ]);
    expect(desk.waste.data.map((w) => w.number)).toEqual([own.number]);
    expect(desk.counts).toEqual({ pendingPurchases: 2, pendingWaste: 1 });
    expect(desk.standing).toEqual({
      approvalLimitKobo: 5_000_000,
      dailyLimitOn: true,
      dailyLimitKobo: 15_000_000,
      approvedTodayKobo: 0,
    });

    const [bigRow, smallRow] = desk.purchases.data;
    expect(bigRow.awaiting).toEqual({
      awaits: 'OWNER',
      valueKobo: 14_000_000,
      readerMayApprove: false,
      refusal: approvalLimitMessage(LIMITED_DECISIONS.purchase, 5_000_000),
    });
    expect(smallRow.awaiting).toEqual({
      awaits: 'MANAGER',
      valueKobo: STEAK_KOBO,
      readerMayApprove: true,
      refusal: null,
    });
    expect(desk.waste.data[0].awaiting).toEqual({
      awaits: 'MANAGER',
      valueKobo: STEAK_KOBO,
      readerMayApprove: false,
      refusal: ownRecordMessage(OWN_RECORD_KINDS.wasteEntry),
    });

    // The predictions are the routes' answers, sentence for sentence.
    const refusedBig = await decide('manager2', 'purchases', bigRow, 'approve');
    expect(refusedBig.status).toBe(403);
    expect(messageOf(refusedBig)).toBe(bigRow.awaiting!.refusal);

    const refusedOwn = await decide(
      'manager2',
      'waste',
      desk.waste.data[0],
      'approve',
    );
    expect(refusedOwn.status).toBe(403);
    expect(messageOf(refusedOwn)).toBe(desk.waste.data[0].awaiting!.refusal);

    // Another manager may approve the entry; the Owner may approve anything.
    const other = await read('manager');
    expect(other.waste.data[0].awaiting).toMatchObject({
      readerMayApprove: true,
      refusal: null,
    });
    const asOwner = await read('owner');
    expect(
      [...asOwner.purchases.data, ...asOwner.waste.data].every(
        (row) => row.awaiting?.readerMayApprove === true,
      ),
    ).toBe(true);
    expect(asOwner.standing.approvedTodayKobo).toBe(0);

    await clearPending();
  });

  it('predicts the Daily Approval Limit from the reader’s own total today', async () => {
    const entries: Waste[] = [];
    for (let i = 0; i < 4; i += 1) entries.push(await logWaste('kitchen'));

    for (const entry of entries.slice(0, 3)) {
      const row = (await read('manager3')).waste.data.find(
        (w) => w.id === entry.id,
      )!;
      expect(row.awaiting).toMatchObject({ readerMayApprove: true });
      await decide('manager3', 'waste', row, 'approve').expect(200);
    }

    const desk = await read('manager3');
    expect(desk.standing.approvedTodayKobo).toBe(12_000_000);
    const fourth = desk.waste.data.find((w) => w.id === entries[3].id)!;
    expect(fourth.awaiting).toEqual({
      awaits: 'MANAGER',
      valueKobo: STEAK_KOBO,
      readerMayApprove: false,
      refusal: dailyLimitMessage(16_000_000, 15_000_000),
    });

    const refused = await decide('manager3', 'waste', fourth, 'approve');
    expect(refused.status).toBe(403);
    expect(messageOf(refused)).toBe(fourth.awaiting!.refusal);

    // Another manager, with a day of their own, may still approve it.
    expect(
      (await read('manager')).waste.data.find((w) => w.id === entries[3].id)!
        .awaiting,
    ).toMatchObject({ readerMayApprove: true });

    await clearPending();
  });

  it('values a pending entry afresh, as its approval will', async () => {
    const entry = await logWaste('kitchen', 2);
    expect(entry.valueKobo).toBe(2 * STEAK_KOBO);

    // A newer requisition, once approved, changes steak's latest pack cost
    // to ₦10,000 (Q25: a Pending one sets nothing).
    const cheaper = await raise([
      { stockItemId: steak.id, qty: 1, costKobo: 1_000_000 },
    ]);
    await decide('owner', 'purchases', cheaper, 'approve').expect(200);

    const row = (await read('manager')).waste.data.find(
      (w) => w.id === entry.id,
    )!;
    // The stored value is the one it was logged at; `awaiting` is the
    // value the approval would now be judged on.
    expect(row.valueKobo).toBe(2 * STEAK_KOBO);
    expect(row.awaiting?.valueKobo).toBe(2_000_000);

    const approved = (
      await decide('manager', 'waste', row, 'approve').expect(200)
    ).body as Waste;
    expect(approved.valueKobo).toBe(row.awaiting!.valueKobo);

    // Steak back at ₦40,000, for the cases after this one.
    const restored = await steakPurchase(1);
    await decide('owner', 'purchases', restored, 'approve').expect(200);

    await clearPending();
  });

  it('searches both lists, pages each on its own, and keeps History newest first', async () => {
    const history = await read('manager', { view: 'HISTORY' });
    const purchases = history.purchases.data;
    expect(purchases.length).toBeGreaterThan(1);
    for (let i = 1; i < purchases.length; i += 1) {
      expect(purchases[i - 1].number > purchases[i].number).toBe(true);
    }
    expect(
      [...purchases, ...history.waste.data].every((r) => r.awaiting === null),
    ).toBe(true);

    const byVendor = await read('manager', {
      view: 'HISTORY',
      q: 'approvals foods',
    });
    expect(byVendor.purchases.total).toBe(history.purchases.total);
    expect(byVendor.waste.total).toBe(0);

    const byItem = await read('manager', { view: 'HISTORY', q: 'STEAK' });
    expect(byItem.waste.total).toBe(history.waste.total);
    expect(byItem.purchases.total).toBe(0);

    const firstPage = await read('manager', {
      view: 'HISTORY',
      pageSize: '1',
    });
    expect(firstPage.purchases.data).toHaveLength(1);
    expect(firstPage.waste.data).toHaveLength(1);
    expect(firstPage.purchases.total).toBe(history.purchases.total);
  });

  it('refuses an unknown view, and everyone but managers', async () => {
    const bad = await approvals('manager', { view: 'ALL' }).expect(400);
    expect(messageOf(bad)).toEqual([APPROVAL_VIEW_MESSAGE]);

    for (const actor of ['storekeeper', 'kitchen', 'waiter'] as const) {
      const refused = await approvals(actor).expect(403);
      expect(messageOf(refused)).toBe(ROLE_REFUSED_MESSAGE);
    }

    await request(server()).get('/api/v1/staff/approvals').expect(401);
  });

  describe('two managers deciding the same record at once', () => {
    const ROUNDS = 3;
    /**
     * ₦1,000 a carton. The first race requisition makes it steak's latest
     * pack cost, so every entry and requisition below is worth ₦1,000 and
     * the two managers' days never reach the Daily Approval Limit: each
     * refusal here is the race's 409, never a 403.
     */
    const RACE_COST_KOBO = 100_000;
    const racePurchase = () => steakPurchase(1, RACE_COST_KOBO);

    async function ledgerRowsFor(ref: string): Promise<number> {
      return prisma.approvalLedger.count({ where: { ref } });
    }

    it('lets one of two Managers approving a requisition win; the other sees the refresh message, and the day counts it once', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const purchase = await racePurchase();

        const results = await Promise.all([
          decide('manager4', 'purchases', purchase, 'approve'),
          decide('manager5', 'purchases', purchase, 'approve'),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(messageOf(results.find((r) => r.status === 409)!)).toBe(
          STALE_VERSION_MESSAGE,
        );
        expect(await ledgerRowsFor(purchase.number)).toBe(1);
        expect(
          await prisma.task.count({
            where: {
              purchaseId: purchase.id,
              title: { startsWith: 'Receive goods' },
            },
          }),
        ).toBe(1);
      }
    });

    it('lets one of two Managers approving a waste entry win, taking the stock once', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const entry = await logWaste('kitchen');
        const before = await prisma.stockMovement.count({
          where: { ref: entry.number },
        });

        const results = await Promise.all([
          decide('manager4', 'waste', entry, 'approve'),
          decide('manager5', 'waste', entry, 'approve'),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(messageOf(results.find((r) => r.status === 409)!)).toBe(
          STALE_VERSION_MESSAGE,
        );
        expect(await ledgerRowsFor(entry.number)).toBe(1);
        expect(
          await prisma.stockMovement.count({ where: { ref: entry.number } }),
        ).toBe(before + 1);
      }
    });

    it('lets an approval and a rejection race: whichever wins stands, and only an approval counts or moves stock', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const purchase = await racePurchase();
        const entry = await logWaste('kitchen');

        const [p1, p2, w1, w2] = await Promise.all([
          decide('manager4', 'purchases', purchase, 'approve'),
          decide('manager5', 'purchases', purchase, 'reject'),
          decide('manager4', 'waste', entry, 'reject'),
          decide('manager5', 'waste', entry, 'approve'),
        ]);

        expect([p1.status, p2.status].sort()).toEqual([200, 409]);
        expect([w1.status, w2.status].sort()).toEqual([200, 409]);

        const storedPurchase = await prisma.purchase.findUniqueOrThrow({
          where: { id: purchase.id },
          select: { status: true },
        });
        expect(storedPurchase.status).toBe(
          p1.status === 200 ? PurchaseStatus.APPROVED : PurchaseStatus.REJECTED,
        );
        expect(await ledgerRowsFor(purchase.number)).toBe(
          p1.status === 200 ? 1 : 0,
        );

        const approvedWaste = w2.status === 200;
        const storedWaste = await prisma.wasteEntry.findUniqueOrThrow({
          where: { id: entry.id },
          select: { status: true },
        });
        expect(storedWaste.status).toBe(
          approvedWaste ? WasteStatus.APPROVED : WasteStatus.REJECTED,
        );
        expect(await ledgerRowsFor(entry.number)).toBe(approvedWaste ? 1 : 0);
        expect(
          await prisma.stockMovement.count({ where: { ref: entry.number } }),
        ).toBe(approvedWaste ? 1 : 0);
      }
    });
  });
});
