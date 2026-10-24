import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  PurchaseStatus,
  StaffRole,
  StockKind,
  StockLocation,
  StockMovementType,
  TaskStatus,
  TaskType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { ADMIN_REASON_MESSAGE } from '../src/common/admin-reason';
import {
  LINES_DUPLICATE_MESSAGE,
  LINES_EMPTY_MESSAGE,
  LINES_QTY_MESSAGE,
} from '../src/common/command-lines';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { IDEMPOTENCY_KEY_REQUIRED } from '../src/idempotency/idempotency-key.decorator';
import {
  approvalLimitMessage,
  dailyLimitMessage,
  LIMITED_DECISIONS,
  OWN_RECORD_KINDS,
  ownRecordCorrectionMessage,
  ownRecordMessage,
} from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import {
  ACTIVE_VENDOR_MESSAGE,
  ARCHIVE_ACTIVE_MESSAGE,
  CREATE_LINE_ITEM_COST_MESSAGE,
  EDIT_ACTIVE_MESSAGE,
  EDIT_LINE_ITEM_COST_MESSAGE,
  PURCHASE_NOT_FOUND_MESSAGE,
  PURCHASE_VIEW_MESSAGE,
  RECEIVE_APPROVED_MESSAGE,
  REVIEW_PENDING_MESSAGE,
  STATUS_LOCKED_MESSAGE,
  STATUS_RECEIVE_MESSAGE,
  VENDOR_NAME_PHONE_MESSAGE,
  VENDOR_NOT_FOUND_MESSAGE,
} from '../src/purchasing/purchasing-messages';
import { latestPackCostKobo, stockValueKobo } from '../src/stock/stock-value';
import { createTestApp } from './create-test-app';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { readBell } from './staff-bell';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * Vendors and purchases (card C5-3) through HTTP and against Postgres:
 * `vendor.save` and the lite list, the requisition from raising to
 * receiving, the managers' corrections, the money rules on an approval, and
 * the automatic tasks with plan §17's R1. The C5 gate's steps 1 to 3 are
 * walked first, in order; the demo's purchase cases (`owner.test.cjs`,
 * `stock.test.cjs`, `domain.test.cjs`, `revision.test.cjs`) are ported by
 * name.
 *
 * It runs on a database of its own (`createIsolatedDatabase`), seeded with
 * the real reference data (`seedData`), because the automatic tasks go to
 * the *first* active Manager and Storekeeper at CNC: on the shared test
 * database those are other suites' accounts, and the gate's "the receive
 * task appears for the Storekeeper" could not be asserted for this suite's
 * Storekeeper. The approval limits are the seeded ₦50,000 and ₦150,000.
 */
describe('Vendors and purchases (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  const originalUrl = process.env.CNC_DB_URL;

  /**
   * The accounts, made in this order: `manager` is the first Manager and so
   * gets every review task; `storekeeper` is the only Storekeeper and gets
   * every receive task.
   */
  type Actor =
    | 'owner'
    | 'manager'
    | 'manager2'
    | 'manager3'
    | 'storekeeper'
    | 'kitchen'
    | 'reception'
    | 'waiter'
    | 'manager4'
    | 'manager5';

  const ROLE: Record<Actor, StaffRole> = {
    owner: StaffRole.OWNER,
    manager: StaffRole.MANAGER,
    manager2: StaffRole.MANAGER,
    manager3: StaffRole.MANAGER,
    storekeeper: StaffRole.STOREKEEPER,
    kitchen: StaffRole.KITCHEN,
    reception: StaffRole.RECEPTION,
    waiter: StaffRole.WAITER,
    manager4: StaffRole.MANAGER,
    manager5: StaffRole.MANAGER,
  };

  const staffId: Partial<Record<Actor, string>> = {};
  const staffName: Partial<Record<Actor, string>> = {};
  const token: Partial<Record<Actor, string>> = {};

  interface PurchaseLine {
    position: number;
    stockItemId: string;
    stockItemName: string;
    pack: string;
    vendorId: string;
    vendorName: string;
    qtyPacks: number;
    costKobo: number;
    receivedPacks: number;
    totalKobo: number;
  }

  interface Purchase {
    id: string;
    number: string;
    vendorId: string;
    vendorName: string;
    status: PurchaseStatus;
    note: string;
    archived: boolean;
    createdById: string;
    createdByName: string;
    decidedById: string | null;
    decidedByName: string | null;
    totalKobo: number;
    receivedValueKobo: number;
    lines: PurchaseLine[];
    version: number;
  }

  interface Vendor {
    id: string;
    name: string;
    service: string;
    phone: string;
    isActive: boolean;
    version: number;
  }

  interface BellItem {
    id: string;
    title: string;
    detail: string;
    page: string;
    category: string;
  }

  /** The run's two vendors and its two Kitchen items. */
  let food: Vendor;
  let drinks: Vendor;
  let rice: { id: string; name: string };
  let beans: { id: string; name: string };

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    const tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);

    for (const actor of Object.keys(ROLE) as Actor[]) {
      const account = await createStaffAccount(prisma, ROLE[actor], {
        emailPrefix: 'purchasing',
        name: `Purchasing ${actor}`,
      });
      staffId[actor] = account.id;
      staffName[actor] = account.name;
      token[actor] = await accessTokenFor(tokens, account.id);
    }

    food = await newVendor('Plateau Fresh Foods', 'Food supplies');
    drinks = await newVendor('Jos Drinks Supply', 'Beverages');
    rice = await kitchenItem('Purchasing Rice', 'bag', 50);
    beans = await kitchenItem('Purchasing Beans', 'bag', 40);
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

  async function newVendor(name: string, service: string): Promise<Vendor> {
    const response = await request(server())
      .post('/api/v1/staff/vendors')
      .set(as('storekeeper'))
      .set('Idempotency-Key', randomUUID())
      .send({ name, service, phone: '08000000010' })
      .expect(201);

    return response.body as Vendor;
  }

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
      .post('/api/v1/staff/purchases')
      .set(as(actor))
      .set('Idempotency-Key', key)
      .send(body);

  /** A requisition raised through the route, expected to succeed. */
  async function raise(
    actor: Actor,
    lines: Record<string, unknown>[],
    extra: Record<string, unknown> = {},
  ): Promise<Purchase> {
    return (await create(actor, { lines, ...extra }).expect(201))
      .body as Purchase;
  }

  /** One line of `packs` packs of rice from the food vendor. */
  const riceLine = (packs: number, costKobo: number) => ({
    stockItemId: rice.id,
    qty: packs,
    costKobo,
    vendorId: food.id,
  });

  const command = (
    actor: Actor,
    target: { id: string; version: number },
    path: 'approve' | 'reject' | 'status' | 'archive' | 'receive',
    body: Record<string, unknown> = {},
  ) =>
    request(server())
      .post(`/api/v1/staff/purchases/${target.id}/${path}`)
      .set(as(actor))
      .send({ version: target.version, ...body });

  const edit = (
    actor: Actor,
    target: { id: string; version: number },
    body: Record<string, unknown>,
  ) =>
    request(server())
      .put(`/api/v1/staff/purchases/${target.id}`)
      .set(as(actor))
      .send({ version: target.version, ...body });

  async function read(id: string): Promise<Purchase> {
    return (
      await request(server())
        .get(`/api/v1/staff/purchases/${id}`)
        .set(as('storekeeper'))
        .expect(200)
    ).body as Purchase;
  }

  /** A purchase's tasks, oldest first, with their history. */
  function tasksOf(purchaseId: string) {
    return prisma.task.findMany({
      where: { purchaseId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        automatic: true,
        assignedToId: true,
        raisedById: true,
        version: true,
        history: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { status: true, staffId: true, automatic: true },
        },
      },
    });
  }

  async function bell(actor: Actor): Promise<BellItem[]> {
    return (await readBell(server(), as(actor))).data;
  }

  async function storeBalance(stockItemId: string): Promise<number> {
    const row = await prisma.stockBalance.findUnique({
      where: {
        stockItemId_location: { stockItemId, location: StockLocation.STORE },
      },
      select: { qty: true },
    });

    return row?.qty ?? 0;
  }

  /** The Store balance must equal the sum of the item's Store movements. */
  async function expectLedgerHolds(stockItemId: string): Promise<void> {
    const sum = await prisma.stockMovement.aggregate({
      where: { stockItemId, location: StockLocation.STORE },
      _sum: { qty: true },
    });

    expect(await storeBalance(stockItemId)).toBe(sum._sum.qty ?? 0);
  }

  async function ledgerTotal(actor: Actor): Promise<number> {
    const sum = await prisma.approvalLedger.aggregate({
      where: { staffId: staffId[actor] },
      _sum: { amountKobo: true },
    });

    return sum._sum.amountKobo ?? 0;
  }

  describe('the C5 gate, steps 1 to 3', () => {
    let gate: Purchase;

    it('1. the Storekeeper raises a purchase above ₦50,000; the Manager’s approval is refused with the Owner Approval Limit message, and the Owner approves', async () => {
      // Two bags of rice at ₦70,000 a bag: ₦140,000.
      gate = await raise('storekeeper', [riceLine(2, 7000000)], {
        note: 'Two bags for next service',
      });

      expect(gate).toMatchObject({
        status: PurchaseStatus.PENDING,
        totalKobo: 14000000,
        vendorName: food.name,
        createdByName: staffName.storekeeper,
      });
      expect(gate.number).toMatch(/^PR-\d{6,}$/);

      const refused = await command('manager', gate, 'approve').expect(403);
      expect(messageOf(refused)).toBe(
        approvalLimitMessage(LIMITED_DECISIONS.purchase, 5000000),
      );
      expect(messageOf(refused)).toBe(
        'This purchase is above the Owner Approval Limit of ₦50,000. The Owner must approve it.',
      );
      expect((await read(gate.id)).status).toBe(PurchaseStatus.PENDING);
      expect(await ledgerTotal('manager')).toBe(0);

      const approved = await command('owner', gate, 'approve').expect(200);
      gate = approved.body as Purchase;
      expect(gate).toMatchObject({
        status: PurchaseStatus.APPROVED,
        decidedById: staffId.owner,
        decidedByName: staffName.owner,
      });
      // The Owner is never recorded in the ledger (D36).
      expect(await ledgerTotal('owner')).toBe(0);
    });

    it('2. the receive task appears for the Storekeeper', async () => {
      const items = await bell('storekeeper');
      expect(items).toContainEqual({
        id: expect.stringMatching(/^task:/) as string,
        title: 'Assigned Task · Open',
        detail: `Receive goods for ${gate.number}`,
        page: 'tasks',
        category: 'Task',
      });

      const tasks = await tasksOf(gate.id);
      expect(tasks.map((t) => [t.title, t.status, t.assignedToId])).toEqual([
        [
          `Review purchase ${gate.number} from ${food.name}`,
          TaskStatus.DONE,
          staffId.manager,
        ],
        [
          `Receive goods for ${gate.number}`,
          TaskStatus.OPEN,
          staffId.storekeeper,
        ],
      ]);
      expect(tasks[0].history).toEqual([
        {
          status: TaskStatus.OPEN,
          staffId: staffId.storekeeper,
          automatic: true,
        },
        { status: TaskStatus.DONE, staffId: staffId.owner, automatic: true },
      ]);
      expect(tasks[1]).toMatchObject({
        type: TaskType.PURCHASE,
        automatic: true,
        raisedById: staffId.owner,
      });
    });

    it('3. receiving raises Store stock', async () => {
      const before = await storeBalance(rice.id);

      const response = await command('storekeeper', gate, 'receive').expect(
        200,
      );
      const body = response.body as {
        purchase: Purchase;
        storeQty: Record<string, number>;
      };

      expect(await storeBalance(rice.id)).toBe(before + 2);
      expect(body.storeQty).toEqual({ [rice.id]: before + 2 });
      expect(body.purchase).toMatchObject({
        status: PurchaseStatus.FULFILLED,
        receivedValueKobo: 14000000,
      });
      expect(body.purchase.lines.map((l) => l.receivedPacks)).toEqual([2]);
      await expectLedgerHolds(rice.id);

      const movement = await prisma.stockMovement.findFirstOrThrow({
        where: { ref: gate.number },
        select: { type: true, qty: true, location: true, staffId: true },
      });
      expect(movement).toEqual({
        type: StockMovementType.PURCHASE_RECEIPT,
        qty: 2,
        location: StockLocation.STORE,
        staffId: staffId.storekeeper,
      });

      // The receive task is done and leaves the Storekeeper's bell.
      const tasks = await tasksOf(gate.id);
      expect(tasks.every((t) => t.status === TaskStatus.DONE)).toBe(true);
      expect(
        (await bell('storekeeper')).some((i) => i.detail.includes(gate.number)),
      ).toBe(false);

      // The pack cost now values Kitchen stock (latestPackCostKobo).
      expect(await latestPackCostKobo(prisma, rice.id)).toBe(7000000);
      const item = await prisma.stockItem.findUniqueOrThrow({
        where: { id: rice.id },
        select: { id: true, kind: true, factor: true, menuItemId: true },
      });
      expect(await stockValueKobo(prisma, item, 50)).toBe(7000000);
      expect(await stockValueKobo(prisma, item, 1)).toBe(140000);
    });
  });

  describe('vendor.save and the lite list', () => {
    it('adds and changes a vendor, keeping its status unless one is sent', async () => {
      const vendor = await newVendor('City Technical Services', 'Electrical');
      expect(vendor).toMatchObject({ isActive: true, version: 0 });

      const off = await request(server())
        .patch(`/api/v1/staff/vendors/${vendor.id}`)
        .set(as('storekeeper'))
        .send({
          version: vendor.version,
          name: vendor.name,
          phone: '08000000012',
          isActive: false,
        })
        .expect(200);
      expect(off.body).toMatchObject({ isActive: false, version: 1 });

      // A phone fix without a status leaves the vendor inactive (R2's rule).
      const fixed = await request(server())
        .patch(`/api/v1/staff/vendors/${vendor.id}`)
        .set(as('manager'))
        .send({ version: 1, name: vendor.name, phone: '08000000013' })
        .expect(200);
      expect(fixed.body).toMatchObject({
        isActive: false,
        phone: '08000000013',
        service: '',
        version: 2,
      });

      const stale = await request(server())
        .patch(`/api/v1/staff/vendors/${vendor.id}`)
        .set(as('storekeeper'))
        .send({ version: 1, name: vendor.name, phone: '1' })
        .expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);

      const missing = await request(server())
        .patch(`/api/v1/staff/vendors/${randomUUID()}`)
        .set(as('storekeeper'))
        .send({ version: 0, name: 'x', phone: '1' })
        .expect(404);
      expect(messageOf(missing)).toBe(VENDOR_NOT_FOUND_MESSAGE);

      const entries = await prisma.auditLog.findMany({
        where: { ref: vendor.id },
        orderBy: { at: 'asc' },
        select: { action: true },
      });
      expect(entries.map((e) => e.action)).toEqual([
        'vendor.save',
        'vendor.save',
        'vendor.save',
      ]);
    });

    it('refuses a blank name or phone with the demo’s sentence, and other roles', async () => {
      for (const body of [
        { name: ' ', phone: '0800' },
        { name: 'Vendor', phone: '' },
        { name: 'Vendor' },
      ]) {
        const response = await request(server())
          .post('/api/v1/staff/vendors')
          .set(as('storekeeper'))
          .set('Idempotency-Key', randomUUID())
          .send(body)
          .expect(400);
        expect(messageOf(response)).toEqual([VENDOR_NAME_PHONE_MESSAGE]);
      }

      for (const actor of ['kitchen', 'reception', 'waiter'] as Actor[]) {
        const response = await request(server())
          .post('/api/v1/staff/vendors')
          .set(as(actor))
          .set('Idempotency-Key', randomUUID())
          .send({ name: 'Vendor', phone: '0800' })
          .expect(403);
        expect(messageOf(response)).toBe(ROLE_REFUSED_MESSAGE);

        await request(server())
          .get('/api/v1/staff/vendors')
          .set(as(actor))
          .expect(403);
      }
    });

    it('replays a retried create under its Idempotency-Key instead of adding the vendor twice', async () => {
      const key = randomUUID();
      const body = { name: `Retry Vendor ${key}`, phone: '0800' };
      const send = () =>
        request(server())
          .post('/api/v1/staff/vendors')
          .set(as('storekeeper'))
          .set('Idempotency-Key', key)
          .send(body);

      const first = await send().expect(201);
      const second = await send().expect(201);
      expect((second.body as Vendor).id).toBe((first.body as Vendor).id);
      expect(await prisma.vendor.count({ where: { name: body.name } })).toBe(1);

      const missing = await request(server())
        .post('/api/v1/staff/vendors')
        .set(as('storekeeper'))
        .send(body)
        .expect(400);
      expect(messageOf(missing)).toBe(IDEMPOTENCY_KEY_REQUIRED);
    });

    it('lists vendors with their contacts for the Storekeeper, and names them to every screen in the lite list', async () => {
      const page = await request(server())
        .get('/api/v1/staff/vendors')
        .query({ q: 'beverages' })
        .set(as('storekeeper'))
        .expect(200);
      expect(page.body).toMatchObject({
        page: 1,
        total: 1,
        data: [{ id: drinks.id, phone: '08000000010' }],
      });

      const reference = await request(server())
        .get('/api/v1/staff/reference')
        .set(as('reception'))
        .expect(200);
      const lite = (reference.body as { vendors: Record<string, unknown>[] })
        .vendors;
      expect(lite.find((v) => v.id === food.id)).toEqual({
        id: food.id,
        name: food.name,
        service: 'Food supplies',
        isActive: true,
      });
    });
  });

  describe('purchase.create', () => {
    it('a purchase retains the selected vendor for every line (domain.test.cjs), and raises a review task for the first Manager', async () => {
      const purchase = await raise('storekeeper', [
        riceLine(1, 7000000),
        {
          stockItemId: beans.id,
          qty: 3,
          costKobo: 500000,
          vendorId: drinks.id,
        },
      ]);

      // A purchase retains the selected vendor for every line (domain.test).
      expect(purchase.lines.map((l) => [l.position, l.vendorId])).toEqual([
        [0, food.id],
        [1, drinks.id],
      ]);
      expect(purchase.vendorId).toBe(food.id);
      expect(purchase.totalKobo).toBe(7000000 + 1500000);

      const [review] = await tasksOf(purchase.id);
      expect(review).toMatchObject({
        title: `Review purchase ${purchase.number} from ${food.name}`,
        type: TaskType.PURCHASE,
        status: TaskStatus.OPEN,
        automatic: true,
        assignedToId: staffId.manager,
        raisedById: staffId.storekeeper,
      });
      // While the approvals alert is on (the default), the manager's bell
      // asks for the decision once, as a Purchase Approval, and leaves the
      // review task off (the demo's rule, C8-2).
      const managerBell = await bell('manager');

      expect(
        managerBell.some(
          (i) =>
            i.title === 'Purchase Approval' &&
            i.detail.startsWith(`${purchase.number} · `),
        ),
      ).toBe(true);
      expect(
        managerBell.some(
          (i) => i.detail === review.title && i.category === 'Task',
        ),
      ).toBe(false);

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { ref: purchase.number },
        select: { action: true, actorRole: true },
      });
      expect(entry).toEqual({
        action: 'purchase.create',
        actorRole: StaffRole.STOREKEEPER,
      });
    });

    it('gives a line without a vendor the requisition’s vendor, as the staff app does', async () => {
      const purchase = await raise(
        'storekeeper',
        [{ stockItemId: rice.id, qty: 1, costKobo: 1000000 }],
        { vendorId: drinks.id },
      );
      expect(purchase.lines[0].vendorId).toBe(drinks.id);
      expect(purchase.vendorName).toBe(drinks.name);
    });

    it('refuses bad lists, vendors, items and costs with the demo’s sentences, in its order', async () => {
      const inactive = await newVendor('Closed Vendor', 'Other');
      await request(server())
        .patch(`/api/v1/staff/vendors/${inactive.id}`)
        .set(as('storekeeper'))
        .send({
          version: 0,
          name: inactive.name,
          phone: '0800',
          isActive: false,
        })
        .expect(200);

      const cases: [Record<string, unknown>[], unknown][] = [
        [[], [LINES_EMPTY_MESSAGE]],
        [[riceLine(1, 100), riceLine(2, 100)], [LINES_DUPLICATE_MESSAGE]],
        [[riceLine(1.5, 100)], [LINES_QTY_MESSAGE]],
        [[riceLine(0, 100)], [LINES_QTY_MESSAGE]],
        [
          [{ ...riceLine(1, 100), vendorId: inactive.id }],
          ACTIVE_VENDOR_MESSAGE,
        ],
        [
          [{ stockItemId: rice.id, qty: 1, costKobo: 100 }],
          ACTIVE_VENDOR_MESSAGE,
        ],
        [
          [{ ...riceLine(1, 100), stockItemId: 'nothing' }],
          CREATE_LINE_ITEM_COST_MESSAGE,
        ],
        [[riceLine(1, 0)], CREATE_LINE_ITEM_COST_MESSAGE],
        [[riceLine(1, 10.5)], CREATE_LINE_ITEM_COST_MESSAGE],
        // The vendor is checked before the item, as in the demo.
        [[{ ...riceLine(1, 0), vendorId: inactive.id }], ACTIVE_VENDOR_MESSAGE],
        // The staff app's untouched new line: neither vendor nor item. The
        // demo's `positiveLines` never checks the item, so the vendor
        // sentence comes first.
        [[{ stockItemId: '', qty: 1, costKobo: 0 }], ACTIVE_VENDOR_MESSAGE],
        [
          [{ ...riceLine(1, 100), stockItemId: '' }],
          CREATE_LINE_ITEM_COST_MESSAGE,
        ],
        [
          [{ ...riceLine(1, 100), stockItemId: 7 }],
          CREATE_LINE_ITEM_COST_MESSAGE,
        ],
      ];

      for (const [lines, message] of cases) {
        const response = await create('storekeeper', { lines }).expect(400);
        expect(messageOf(response)).toEqual(message);
      }

      for (const actor of ['kitchen', 'reception', 'waiter'] as Actor[]) {
        const response = await create(actor, {
          lines: [riceLine(1, 100)],
        }).expect(403);
        expect(messageOf(response)).toBe(ROLE_REFUSED_MESSAGE);
      }

      const missing = await request(server())
        .post('/api/v1/staff/purchases')
        .set(as('storekeeper'))
        .send({ lines: [riceLine(1, 100)] })
        .expect(400);
      expect(messageOf(missing)).toBe(IDEMPOTENCY_KEY_REQUIRED);
    });
  });

  describe('approve and reject', () => {
    it('purchases above the limit need the Owner and nobody but the Owner approves their own', async () => {
      // A small Storekeeper purchase: a manager approves it.
      const small = await raise('storekeeper', [riceLine(1, 1000000)]);
      const approved = await command('manager2', small, 'approve').expect(200);
      expect((approved.body as Purchase).status).toBe(PurchaseStatus.APPROVED);

      // A manager's own purchase: refused by either route, approved by another manager.
      const mine = await raise('manager', [riceLine(1, 1000000)]);
      expect(mine.createdById).toBe(staffId.manager);

      const own = await command('manager', mine, 'approve').expect(403);
      expect(messageOf(own)).toBe(ownRecordMessage(OWN_RECORD_KINDS.purchase));
      const ownStatus = await command('manager', mine, 'status', {
        status: PurchaseStatus.APPROVED,
        reason: 'x',
      }).expect(403);
      expect(messageOf(ownStatus)).toBe(
        'You cannot approve a purchase you created. The Owner or another manager must approve it.',
      );

      const other = await command('manager2', mine, 'approve').expect(200);
      expect((other.body as Purchase).status).toBe(PurchaseStatus.APPROVED);
    });

    it('a manager cannot approve their own purchase even by another route, but may reject it; the Owner may approve it', async () => {
      const a = await raise('manager', [riceLine(1, 1000000)]);
      const rejected = await command('manager', a, 'reject').expect(200);
      expect(rejected.body).toMatchObject({
        status: PurchaseStatus.REJECTED,
        decidedById: staffId.manager,
      });

      const b = await raise('owner', [riceLine(1, 1000000)]);
      const ownerApproved = await command('owner', b, 'approve').expect(200);
      expect((ownerApproved.body as Purchase).status).toBe(
        PurchaseStatus.APPROVED,
      );
    });

    it('purchases require manager approval before one-time receiving', async () => {
      const before = await storeBalance(beans.id);
      const purchase = await raise('storekeeper', [
        { stockItemId: beans.id, qty: 2, costKobo: 500000, vendorId: food.id },
      ]);

      const early = await command('storekeeper', purchase, 'receive').expect(
        409,
      );
      expect(messageOf(early)).toBe(RECEIVE_APPROVED_MESSAGE);

      const approved = (await command('owner', purchase, 'approve').expect(200))
        .body as Purchase;
      const received = (
        await command('storekeeper', approved, 'receive').expect(200)
      ).body as { purchase: Purchase };
      expect(await storeBalance(beans.id)).toBe(before + 2);

      const again = await command(
        'storekeeper',
        received.purchase,
        'receive',
      ).expect(409);
      expect(messageOf(again)).toBe(RECEIVE_APPROVED_MESSAGE);
      expect(await storeBalance(beans.id)).toBe(before + 2);
      await expectLedgerHolds(beans.id);
    });

    it('a purchase raises a review task for the manager, then a receive task for the store, and both close', async () => {
      const before = await prisma.task.count();
      const p = await raise('storekeeper', [riceLine(1, 500000)], {
        note: 'Test',
      });
      const [review] = await tasksOf(p.id);
      expect(review.title.startsWith('Review')).toBe(true);
      expect(review.assignedToId).toBe(staffId.manager);
      expect(review.status).toBe(TaskStatus.OPEN);

      const approved = (await command('manager2', p, 'approve').expect(200))
        .body as Purchase;
      let tasks = await tasksOf(p.id);
      expect(tasks[0].status).toBe(TaskStatus.DONE);
      const receive = tasks.find((t) => t.title.startsWith('Receive'));
      expect(receive?.assignedToId).toBe(staffId.storekeeper);

      await command('storekeeper', approved, 'receive').expect(200);
      tasks = await tasksOf(p.id);
      expect(tasks.find((t) => t.id === receive?.id)?.status).toBe(
        TaskStatus.DONE,
      );
      expect(await prisma.task.count()).toBe(before + 2);
    });

    it('counts approvals toward the Daily Approval Limit and refuses the one that crosses it', async () => {
      for (let n = 0; n < 3; n++) {
        const p = await raise('storekeeper', [riceLine(1, 4000000)]);
        await command('manager3', p, 'approve').expect(200);
      }
      expect(await ledgerTotal('manager3')).toBe(12000000);

      const fourth = await raise('storekeeper', [riceLine(1, 4000000)]);
      const refused = await command('manager3', fourth, 'approve').expect(403);
      expect(messageOf(refused)).toBe(dailyLimitMessage(16000000, 15000000));
      expect((await read(fourth.id)).status).toBe(PurchaseStatus.PENDING);
      expect(await ledgerTotal('manager3')).toBe(12000000);
    });

    it('refuses a decided requisition, other roles and a stale version', async () => {
      const p = await raise('storekeeper', [riceLine(1, 100000)]);

      const role = await command('storekeeper', p, 'approve').expect(403);
      expect(messageOf(role)).toBe(ROLE_REFUSED_MESSAGE);

      const rejected = (
        await command('manager2', p, 'reject', {
          reason: 'Duplicate order',
        }).expect(200)
      ).body as Purchase;

      for (const path of ['approve', 'reject'] as const) {
        const again = await command('manager2', rejected, path).expect(409);
        expect(messageOf(again)).toBe(REVIEW_PENDING_MESSAGE);
      }

      const stale = await command('manager2', p, 'approve').expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);

      const missing = await command(
        'manager2',
        { id: randomUUID(), version: 0 },
        'approve',
      ).expect(404);
      expect(messageOf(missing)).toBe(PURCHASE_NOT_FOUND_MESSAGE);

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { ref: p.number, action: 'purchase.reject' },
        select: { reason: true },
      });
      expect(entry.reason).toBe('Duplicate order');
    });

    it('lets one of two managers approving at once win; the other sees the refresh message', async () => {
      const p = await raise('storekeeper', [riceLine(1, 100000)]);

      const [one, two] = await Promise.all([
        command('manager2', p, 'approve'),
        command('owner', p, 'approve'),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      expect(messageOf(one.status === 409 ? one : two)).toBe(
        STALE_VERSION_MESSAGE,
      );

      const receiveTasks = (await tasksOf(p.id)).filter((t) =>
        t.title.startsWith('Receive'),
      );
      expect(receiveTasks).toHaveLength(1);
    });

    it('receives once when two receipts race', async () => {
      const p = await raise('storekeeper', [riceLine(3, 100000)]);
      const approved = (await command('owner', p, 'approve').expect(200))
        .body as Purchase;
      const before = await storeBalance(rice.id);

      const results = await Promise.all([
        command('storekeeper', approved, 'receive'),
        command('manager', approved, 'receive'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await storeBalance(rice.id)).toBe(before + 3);
      await expectLedgerHolds(rice.id);
    });
  });

  describe('purchase.status: the receive task follows an approval by status (R1)', () => {
    it('opens the receive task on Approved, puts the review back on Pending, and closes both on Rejected', async () => {
      let p = await raise('storekeeper', [riceLine(1, 100000)]);
      const manual = await prisma.task.create({
        data: {
          number: `T-MANUAL-${randomUUID()}`,
          title: 'Call the vendor about delivery',
          type: TaskType.PURCHASE,
          assignedToId: staffId.storekeeper!,
          raisedById: staffId.manager!,
          purchaseId: p.id,
        },
        select: { id: true },
      });

      p = (
        await command('manager2', p, 'status', {
          status: PurchaseStatus.APPROVED,
          reason: 'Agreed by phone',
        }).expect(200)
      ).body as Purchase;
      expect(p.status).toBe(PurchaseStatus.APPROVED);
      expect(await ledgerTotal('manager2')).toBeGreaterThan(0);

      let tasks = await tasksOf(p.id);
      const open = () =>
        tasks
          .filter((t) => t.status !== TaskStatus.DONE)
          .map((t) => [t.title, t.assignedToId]);
      expect(open()).toEqual([
        ['Call the vendor about delivery', staffId.storekeeper],
        [`Receive goods for ${p.number}`, staffId.storekeeper],
      ]);

      p = (
        await command('manager2', p, 'status', {
          status: PurchaseStatus.PENDING,
          reason: 'Prices changed',
        }).expect(200)
      ).body as Purchase;
      expect(p.decidedById).toBeNull();
      tasks = await tasksOf(p.id);
      expect(open()).toEqual([
        ['Call the vendor about delivery', staffId.storekeeper],
        [`Review purchase ${p.number} from ${food.name}`, staffId.manager],
      ]);

      p = (
        await command('manager2', p, 'status', {
          status: PurchaseStatus.REJECTED,
          reason: 'Not needed',
        }).expect(200)
      ).body as Purchase;
      tasks = await tasksOf(p.id);
      expect(open()).toEqual([
        ['Call the vendor about delivery', staffId.storekeeper],
      ]);
      expect(tasks.find((t) => t.id === manual.id)?.version).toBe(0);

      const entries = await prisma.auditLog.findMany({
        where: { ref: p.number, action: 'purchase.status' },
        select: { reason: true },
        orderBy: { at: 'asc' },
      });
      expect(entries.map((e) => e.reason)).toEqual([
        'Agreed by phone',
        'Prices changed',
        'Not needed',
      ]);
    });

    it('refuses Fulfilled, a missing reason, other roles, and a received requisition', async () => {
      const p = await raise('storekeeper', [riceLine(1, 100000)]);

      const fulfilled = await command('manager2', p, 'status', {
        status: PurchaseStatus.FULFILLED,
        reason: 'x',
      }).expect(400);
      expect(messageOf(fulfilled)).toEqual([STATUS_RECEIVE_MESSAGE]);

      const noReason = await command('manager2', p, 'status', {
        status: PurchaseStatus.CANCELLED,
      }).expect(400);
      expect(messageOf(noReason)).toEqual([ADMIN_REASON_MESSAGE]);

      await command('storekeeper', p, 'status', {
        status: PurchaseStatus.CANCELLED,
        reason: 'x',
      }).expect(403);

      const approved = (await command('owner', p, 'approve').expect(200))
        .body as Purchase;
      const received = (
        await command('storekeeper', approved, 'receive').expect(200)
      ).body as { purchase: Purchase };

      const locked = await command('owner', received.purchase, 'status', {
        status: PurchaseStatus.PENDING,
        reason: 'Try reopen',
      }).expect(409);
      expect(messageOf(locked)).toBe(STATUS_LOCKED_MESSAGE);
    });
  });

  describe('purchase.edit and purchase.archive', () => {
    it('received purchase correction changes only stock difference and archive retains receipt', async () => {
      let p = await raise('storekeeper', [riceLine(2, 7000000)]);
      p = (await command('owner', p, 'approve').expect(200)).body as Purchase;
      p = (
        (await command('storekeeper', p, 'receive').expect(200)).body as {
          purchase: Purchase;
        }
      ).purchase;
      const before = await storeBalance(rice.id);

      p = (
        await edit('owner', p, {
          lines: [riceLine(3, 7000000)],
          reason: 'Correct count',
        }).expect(200)
      ).body as Purchase;
      expect(await storeBalance(rice.id)).toBe(before + 1);
      expect(p.lines.map((l) => [l.qtyPacks, l.receivedPacks])).toEqual([
        [3, 3],
      ]);
      const correction = await prisma.stockMovement.findFirstOrThrow({
        where: { ref: p.number, type: StockMovementType.PURCHASE_CORRECTION },
        select: { qty: true },
      });
      expect(correction.qty).toBe(1);

      p = (
        await command('manager', p, 'archive', {
          reason: 'Duplicate paperwork',
        }).expect(200)
      ).body as Purchase;
      expect(await storeBalance(rice.id)).toBe(before + 1);
      expect(p).toMatchObject({
        archived: true,
        status: PurchaseStatus.FULFILLED,
      });
      await expectLedgerHolds(rice.id);

      const last = await prisma.auditLog.findFirstOrThrow({
        where: { ref: p.number },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        select: { action: true },
      });
      expect(last.action).toBe('purchase.archive');

      const reopen = await command('manager', p, 'status', {
        status: PurchaseStatus.PENDING,
        reason: 'Try reopen',
      }).expect(409);
      expect(messageOf(reopen)).toBe(STATUS_LOCKED_MESSAGE);
    });

    it('archives a requisition with nothing received as Cancelled and closes its open tasks (R1)', async () => {
      let p = await raise('storekeeper', [riceLine(1, 100000)]);
      p = (await command('owner', p, 'approve').expect(200)).body as Purchase;
      expect(
        (await tasksOf(p.id)).filter((t) => t.status !== TaskStatus.DONE),
      ).toHaveLength(1);

      p = (
        await command('manager', p, 'archive', {
          reason: 'Vendor closed',
        }).expect(200)
      ).body as Purchase;
      expect(p).toMatchObject({
        archived: true,
        status: PurchaseStatus.CANCELLED,
      });
      expect(
        (await tasksOf(p.id)).every((t) => t.status === TaskStatus.DONE),
      ).toBe(true);
      expect(
        (await bell('storekeeper')).some((i) => i.detail.includes(p.number)),
      ).toBe(false);

      const again = await command('manager', p, 'archive', {
        reason: 'again',
      }).expect(409);
      expect(messageOf(again)).toBe(ARCHIVE_ACTIVE_MESSAGE);

      const editArchived = await edit('owner', p, {
        lines: [riceLine(1, 100000)],
        reason: 'x',
      }).expect(409);
      expect(messageOf(editArchived)).toBe(EDIT_ACTIVE_MESSAGE);

      const receiveArchived = await command('storekeeper', p, 'receive').expect(
        409,
      );
      expect(messageOf(receiveArchived)).toBe(RECEIVE_APPROVED_MESSAGE);
    });

    it('holds a manager’s edit to the Owner Approval Limit on the old and the new totals, and checks lines in the edit’s order', async () => {
      const big = await raise('storekeeper', [riceLine(1, 6000000)]);

      const overOld = await edit('manager', big, {
        lines: [riceLine(1, 100000)],
        reason: 'Cheaper',
      }).expect(403);
      expect(messageOf(overOld)).toBe(
        approvalLimitMessage(LIMITED_DECISIONS.purchase, 5000000),
      );

      const small = await raise('storekeeper', [riceLine(1, 100000)]);
      const overNew = await edit('manager', small, {
        lines: [riceLine(1, 6000000)],
        reason: 'Dearer',
      }).expect(403);
      expect(messageOf(overNew)).toBe(
        approvalLimitMessage(LIMITED_DECISIONS.purchase, 5000000),
      );

      // The item is checked before the vendor in an edit; the vendor is required.
      const noVendor = await edit('manager', small, {
        lines: [{ stockItemId: rice.id, qty: 1, costKobo: 100 }],
        reason: 'x',
      }).expect(400);
      expect(messageOf(noVendor)).toBe(ACTIVE_VENDOR_MESSAGE);
      const badItem = await edit('manager', small, {
        lines: [{ stockItemId: 'nothing', qty: 1, costKobo: 100 }],
        reason: 'x',
      }).expect(400);
      expect(messageOf(badItem)).toBe(EDIT_LINE_ITEM_COST_MESSAGE);
      const badCost = await edit('manager', small, {
        lines: [{ stockItemId: rice.id, qty: 1, costKobo: 0 }],
        reason: 'x',
      }).expect(400);
      expect(messageOf(badCost)).toBe(EDIT_LINE_ITEM_COST_MESSAGE);
      // Neither item nor vendor: the edit asks for the item first.
      const blank = await edit('manager', small, {
        lines: [{ stockItemId: '', qty: 1, costKobo: 0 }],
        reason: 'x',
      }).expect(400);
      expect(messageOf(blank)).toBe(EDIT_LINE_ITEM_COST_MESSAGE);

      const noReason = await edit('manager', small, {
        lines: [riceLine(1, 100)],
      }).expect(400);
      expect(messageOf(noReason)).toEqual([ADMIN_REASON_MESSAGE]);

      await edit('storekeeper', small, {
        lines: [riceLine(1, 100)],
        reason: 'x',
      }).expect(403);

      const edited = (
        await edit('manager', small, {
          lines: [
            riceLine(2, 200000),
            {
              stockItemId: beans.id,
              qty: 1,
              costKobo: 300000,
              vendorId: drinks.id,
            },
          ],
          note: 'Two lines now',
          reason: 'Added beans',
        }).expect(200)
      ).body as Purchase;
      expect(edited).toMatchObject({
        status: PurchaseStatus.PENDING,
        note: 'Two lines now',
        totalKobo: 700000,
        version: small.version + 1,
      });
      expect(edited.lines.map((l) => [l.stockItemId, l.receivedPacks])).toEqual(
        [
          [rice.id, 0],
          [beans.id, 0],
        ],
      );
    });
  });

  describe('correcting an approved requisition (the founder’s decision of 2026-10-22)', () => {
    /** A requisition the Storekeeper (or `by`) raises and the Owner approves. */
    async function approvedPurchase(
      lines: Record<string, unknown>[],
      by: Actor = 'storekeeper',
    ): Promise<Purchase> {
      const raised = await raise(by, lines);

      return (await command('owner', raised, 'approve').expect(200))
        .body as Purchase;
    }

    async function editRows(actor: Actor) {
      return prisma.approvalLedger.findMany({
        where: { staffId: staffId[actor], action: 'purchase.edit' },
        orderBy: { createdAt: 'asc' },
        select: { amountKobo: true, ref: true },
      });
    }

    /** `count` approvals of ₦40,000 requisitions by `actor`, to fill a day. */
    async function approveForty(actor: Actor, count: number): Promise<void> {
      for (let n = 0; n < count; n += 1) {
        const p = await raise('storekeeper', [riceLine(1, 4000000)]);
        await command(actor, p, 'approve').expect(200);
      }
    }

    it('counts an Approved or Fulfilled requisition’s increase toward the editor’s day, nothing for a decrease or a Pending one, and still holds the new total to the Owner Approval Limit', async () => {
      let p = await approvedPurchase([riceLine(1, 1000000)]);

      p = (
        await edit('manager4', p, {
          lines: [riceLine(3, 1000000)],
          reason: 'Three bags came',
        }).expect(200)
      ).body as Purchase;
      expect(await editRows('manager4')).toEqual([
        { amountKobo: 2000000, ref: p.number },
      ]);

      p = (
        await edit('manager4', p, {
          lines: [riceLine(2, 1000000)],
          reason: 'Two after all',
        }).expect(200)
      ).body as Purchase;
      expect(await editRows('manager4')).toHaveLength(1);

      const over = await edit('manager4', p, {
        lines: [riceLine(6, 1000000)],
        reason: 'Six',
      }).expect(403);
      expect(messageOf(over)).toBe(
        approvalLimitMessage(LIMITED_DECISIONS.purchase, 5000000),
      );
      expect((await read(p.id)).totalKobo).toBe(2000000);

      // A Pending requisition's correction decides nothing yet.
      const pending = await raise('storekeeper', [riceLine(1, 100000)]);
      await edit('manager4', pending, {
        lines: [riceLine(4, 100000)],
        reason: 'Four',
      }).expect(200);
      expect(await editRows('manager4')).toHaveLength(1);

      // A received (Fulfilled) requisition was approved: its increase counts.
      let received = await approvedPurchase([riceLine(1, 1000000)]);
      received = (
        (await command('storekeeper', received, 'receive').expect(200))
          .body as { purchase: Purchase }
      ).purchase;
      const storeBefore = await storeBalance(rice.id);
      await edit('manager4', received, {
        lines: [riceLine(2, 1000000)],
        reason: 'Two bags arrived',
      }).expect(200);
      expect(await storeBalance(rice.id)).toBe(storeBefore + 1);
      expect(await editRows('manager4')).toEqual([
        { amountKobo: 2000000, ref: p.number },
        { amountKobo: 1000000, ref: received.number },
      ]);
      await expectLedgerHolds(rice.id);
    });

    it('refuses the increase that crosses the Daily Approval Limit and lets the Owner make it', async () => {
      // manager4's day: ₦30,000 from the case above and three ₦40,000
      // approvals, ₦150,000, the limit itself.
      await approveForty('manager4', 3);
      expect(await ledgerTotal('manager4')).toBe(15000000);

      const p = await approvedPurchase([riceLine(1, 1000000)]);
      const crossing = await edit('manager4', p, {
        lines: [riceLine(2, 1000000)],
        reason: 'Two',
      }).expect(403);
      expect(messageOf(crossing)).toBe(dailyLimitMessage(16000000, 15000000));
      expect(await read(p.id)).toMatchObject({
        totalKobo: 1000000,
        version: p.version,
      });
      expect(
        await prisma.approvalLedger.count({ where: { ref: p.number } }),
      ).toBe(0);

      // The Owner has no limit and is never recorded.
      await edit('owner', p, {
        lines: [riceLine(2, 1000000)],
        reason: 'Two',
      }).expect(200);
      expect(await ledgerTotal('owner')).toBe(0);
    });

    it('refuses a manager correcting an approved requisition they raised, either way; another manager, the Owner on their own, and a Pending one pass', async () => {
      const mine = await approvedPurchase([riceLine(2, 1000000)], 'manager2');

      for (const packs of [3, 1]) {
        const refused = await edit('manager2', mine, {
          lines: [riceLine(packs, 1000000)],
          reason: 'Mine',
        }).expect(403);
        expect(messageOf(refused)).toBe(
          ownRecordCorrectionMessage(OWN_RECORD_KINDS.purchase),
        );
        expect(messageOf(refused)).toBe(
          'You cannot change an approved purchase you created. The Owner or another manager must change it.',
        );
      }
      expect((await read(mine.id)).version).toBe(mine.version);

      await edit('manager3', mine, {
        lines: [riceLine(1, 1000000)],
        reason: 'One',
      }).expect(200);

      const ownersOwn = await approvedPurchase([riceLine(1, 1000000)], 'owner');
      await edit('owner', ownersOwn, {
        lines: [riceLine(2, 1000000)],
        reason: 'Two',
      }).expect(200);

      const pending = await raise('manager2', [riceLine(1, 100000)]);
      await edit('manager2', pending, {
        lines: [riceLine(2, 100000)],
        reason: 'Two',
      }).expect(200);
    });

    it('lets two increases by one manager racing past the day’s limit through one at a time: one passes, the other is refused', async () => {
      await approveForty('manager5', 3);

      const first = await approvedPurchase([riceLine(1, 1000000)]);
      const second = await approvedPurchase([riceLine(1, 1000000)]);

      // Each +₦30,000 fits alone (₦150,000); both would be ₦180,000.
      const results = await Promise.all(
        [first, second].map((p) =>
          edit('manager5', p, {
            lines: [riceLine(4, 1000000)],
            reason: 'Four',
          }),
        ),
      );

      expect(results.map((response) => response.status).sort()).toEqual([
        200, 403,
      ]);
      expect(
        messageOf(results.find((response) => response.status === 403)!),
      ).toBe(dailyLimitMessage(18000000, 15000000));
      expect(await editRows('manager5')).toEqual([
        expect.objectContaining({ amountKobo: 3000000 }),
      ]);
      expect(await ledgerTotal('manager5')).toBe(15000000);
    });
  });

  describe('the reads and the history', () => {
    it('lists the active and history views with the screen’s figures', async () => {
      const all = await request(server())
        .get('/api/v1/staff/purchases')
        .query({ pageSize: 100 })
        .set(as('storekeeper'))
        .expect(200);
      const body = all.body as {
        data: Purchase[];
        total: number;
        counts: {
          awaitingApproval: number;
          approvedNotReceived: number;
          receivedValueKobo: number;
        };
      };
      const rows = await prisma.purchase.findMany({
        select: { status: true, archived: true },
      });
      expect(body.total).toBe(rows.length);
      expect(body.counts.awaitingApproval).toBe(
        rows.filter((r) => r.status === PurchaseStatus.PENDING && !r.archived)
          .length,
      );
      expect(body.counts.approvedNotReceived).toBe(
        rows.filter((r) => r.status === PurchaseStatus.APPROVED && !r.archived)
          .length,
      );
      expect(body.counts.receivedValueKobo).toBe(
        body.data.reduce((sum, p) => sum + p.receivedValueKobo, 0),
      );

      const view = async (name: string) =>
        (
          (
            await request(server())
              .get('/api/v1/staff/purchases')
              .query({ view: name, pageSize: 100 })
              .set(as('manager'))
              .expect(200)
          ).body as { data: Purchase[] }
        ).data;
      const closed = (p: Purchase) =>
        p.archived ||
        (
          [
            PurchaseStatus.FULFILLED,
            PurchaseStatus.REJECTED,
            PurchaseStatus.CANCELLED,
          ] as PurchaseStatus[]
        ).includes(p.status);

      const active = await view('ACTIVE');
      const history = await view('HISTORY');
      expect(active.every((p) => !closed(p))).toBe(true);
      expect(history.every(closed)).toBe(true);
      expect(active.length + history.length).toBe(rows.length);

      const bad = await request(server())
        .get('/api/v1/staff/purchases')
        .query({ view: 'DONE' })
        .set(as('manager'))
        .expect(400);
      expect(messageOf(bad)).toEqual([PURCHASE_VIEW_MESSAGE]);

      const byVendor = (
        (
          await request(server())
            .get('/api/v1/staff/purchases')
            .query({ q: 'jos drinks', pageSize: 100 })
            .set(as('storekeeper'))
            .expect(200)
        ).body as { data: Purchase[] }
      ).data;
      expect(byVendor.length).toBeGreaterThan(0);
      expect(
        byVendor.every((p) => p.lines.some((l) => l.vendorId === drinks.id)),
      ).toBe(true);

      for (const actor of ['kitchen', 'reception', 'waiter'] as Actor[]) {
        await request(server())
          .get('/api/v1/staff/purchases')
          .set(as(actor))
          .expect(403);
      }

      const missing = await request(server())
        .get(`/api/v1/staff/purchases/${randomUUID()}`)
        .set(as('storekeeper'))
        .expect(404);
      expect(messageOf(missing)).toBe(PURCHASE_NOT_FOUND_MESSAGE);
    });

    it('lets the Storekeeper read a purchase’s history, and no other non-manager', async () => {
      const p = await raise('storekeeper', [riceLine(1, 100000)]);
      await command('manager2', p, 'approve').expect(200);

      const history = (actor: Actor) =>
        request(server())
          .get('/api/v1/staff/audit')
          .query({ ref: p.number })
          .set(as(actor));

      const response = await history('storekeeper').expect(200);
      expect(
        (response.body as { data: { action: string }[] }).data.map(
          (row) => row.action,
        ),
      ).toEqual(['purchase.approve', 'purchase.create']);

      for (const actor of ['kitchen', 'reception'] as Actor[]) {
        await history(actor).expect(403);
      }

      await request(server())
        .get('/api/v1/staff/audit')
        .query({ ref: 'PR-999999999' })
        .set(as('storekeeper'))
        .expect(403);
    });
  });

  describe('the automatic tasks’ assignees', () => {
    it('sends the receive task to a manager when CNC has no active Storekeeper', async () => {
      const p = await raise('storekeeper', [riceLine(1, 100000)]);

      await prisma.staff.update({
        where: { id: staffId.storekeeper },
        data: { isActive: false },
      });

      try {
        await command('manager2', p, 'approve').expect(200);
      } finally {
        await prisma.staff.update({
          where: { id: staffId.storekeeper },
          data: { isActive: true },
        });
      }

      const receive = (await tasksOf(p.id)).find((t) =>
        t.title.startsWith('Receive'),
      );
      expect(receive?.assignedToId).toBe(staffId.manager);
    });

    it('values a Kitchen item at the latest Approved or Fulfilled requisition only (Q25)', async () => {
      const item = await kitchenItem(
        `Purchasing Oil ${randomUUID()}`,
        'tin',
        10,
      );
      const oilLine = (costKobo: number) => ({
        stockItemId: item.id,
        qty: 1,
        costKobo,
        vendorId: food.id,
      });
      expect(await latestPackCostKobo(prisma, item.id)).toBeNull();

      // A Pending requisition sets no cost: nobody has agreed it yet.
      const first = await raise('storekeeper', [oilLine(200000)]);
      expect(await latestPackCostKobo(prisma, item.id)).toBeNull();
      await command('manager2', first, 'approve').expect(200);
      expect(await latestPackCostKobo(prisma, item.id)).toBe(200000);

      const later = await raise('storekeeper', [oilLine(300000)]);
      expect(await latestPackCostKobo(prisma, item.id)).toBe(200000);

      await command('manager2', later, 'reject').expect(200);
      expect(await latestPackCostKobo(prisma, item.id)).toBe(200000);

      // Received (Fulfilled) still sets it; Cancelled never does.
      let received = await raise('storekeeper', [oilLine(250000)]);
      received = (await command('manager2', received, 'approve').expect(200))
        .body as Purchase;
      await command('storekeeper', received, 'receive').expect(200);
      expect(await latestPackCostKobo(prisma, item.id)).toBe(250000);

      let cancelled = await raise('storekeeper', [oilLine(900000)]);
      cancelled = (await command('manager2', cancelled, 'approve').expect(200))
        .body as Purchase;
      expect(await latestPackCostKobo(prisma, item.id)).toBe(900000);
      await command('manager', cancelled, 'archive', {
        reason: 'Vendor closed',
      }).expect(200);
      expect(await latestPackCostKobo(prisma, item.id)).toBe(250000);

      const valued = await prisma.stockItem.findUniqueOrThrow({
        where: { id: item.id },
        select: { id: true, kind: true, factor: true, menuItemId: true },
      });
      expect(valued.kind).toBe(StockKind.KITCHEN);
      expect(await stockValueKobo(prisma, valued, 5)).toBe(125000);
    });
  });
});
