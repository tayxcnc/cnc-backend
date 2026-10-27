import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  PurchaseStatus,
  StaffRole,
  StockLocation,
  StockMovementType,
  StockRequestStatus,
  TaskStatus,
  WasteReason,
  WasteStatus,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { staffQrPayload } from '../src/staff/staff-qr';
import { createTestApp } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { readBell } from './staff-bell';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * The founder's C5 gate (plan §15, C5), steps 1 to 7, walked against the
 * API in order, as the staff app will drive it (card C5-8's e2e walk). The
 * sentences are asserted as whole strings, byte for byte as the screens
 * will show them.
 *
 * It runs on a database of its own (`createIsolatedDatabase`) seeded with
 * the real reference data (`seedData`): the limits are the seeded ₦50,000
 * per decision and ₦150,000 a day, and this suite's Manager and
 * Storekeeper are CNC's first, so the automatic tasks go to them. No
 * Kitchen item or stock is seeded (Q11): the walk makes its items, buys
 * them through a requisition and moves them through the Store, as CNC will.
 *
 * **The clock is controlled** (`fakeDateOnly`): the walk starts at the
 * next 12:00 in Jos, so every approval falls on one business date, and
 * moves forward only for step 7's departure scan, which must come after
 * the 60-second repeat window. Tokens are minted afresh after the move.
 *
 * The steps share state and must run in order; each is one test so a
 * failure names its step.
 */
describe('the C5 gate (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  const originalUrl = process.env.CNC_DB_URL;

  type Actor =
    'owner' | 'manager' | 'manager2' | 'storekeeper' | 'kitchen' | 'reception';

  const ROLE: Record<Actor, StaffRole> = {
    owner: StaffRole.OWNER,
    manager: StaffRole.MANAGER,
    manager2: StaffRole.MANAGER,
    storekeeper: StaffRole.STOREKEEPER,
    kitchen: StaffRole.KITCHEN,
    reception: StaffRole.RECEPTION,
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
    awaiting?: Awaiting | null;
    version: number;
  }

  interface Waste {
    id: string;
    number: string;
    status: WasteStatus;
    valueKobo: number;
    awaiting?: Awaiting | null;
    version: number;
  }

  interface StockRequest {
    id: string;
    number: string;
    status: StockRequestStatus;
    version: number;
  }

  let vendor: { id: string; name: string };
  /** Rice: ₦70,000 a bag of 50 portions. */
  let rice: { id: string; name: string };
  /** Steak: ₦40,000 a carton of one, so each one written off is ₦40,000. */
  let steak: { id: string; name: string };
  /** Step 1's requisition, received in step 3. */
  let gate: Purchase;

  async function mintTokens(): Promise<void> {
    for (const actor of Object.keys(ROLE) as Actor[]) {
      token[actor] = await accessTokenFor(tokens, staffId[actor]!);
    }
  }

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);

    for (const actor of Object.keys(ROLE) as Actor[]) {
      const account = await createStaffAccount(prisma, ROLE[actor], {
        emailPrefix: 'c5gate',
        name: `Gate ${actor}`,
      });
      staffId[actor] = account.id;
    }

    fakeDateOnly(nextNoonInJos());
    await mintTokens();

    vendor = (
      await request(server())
        .post('/api/v1/staff/vendors')
        .set(as('storekeeper'))
        .set('Idempotency-Key', randomUUID())
        .send({
          name: 'Plateau Fresh Foods',
          service: 'Food supplies',
          phone: '08000000040',
        })
        .expect(201)
    ).body as { id: string; name: string };

    rice = await kitchenItem('Rice', 'bag', 50);
    steak = await kitchenItem('Steak', 'carton', 1);
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

  async function kitchenItem(
    name: string,
    pack: string,
    factor: number,
  ): Promise<{ id: string; name: string }> {
    return (
      await request(server())
        .post('/api/v1/staff/stock/items')
        .set(as('manager'))
        .send({ name, unit: 'portion', pack, factor, minimum: 10 })
        .expect(201)
    ).body as { id: string; name: string };
  }

  async function raise(
    stockItemId: string,
    qty: number,
    costKobo: number,
  ): Promise<Purchase> {
    return (
      await request(server())
        .post('/api/v1/staff/purchases')
        .set(as('storekeeper'))
        .set('Idempotency-Key', randomUUID())
        .send({ vendorId: vendor.id, lines: [{ stockItemId, qty, costKobo }] })
        .expect(201)
    ).body as Purchase;
  }

  const decide = (
    actor: Actor,
    kind: 'purchases' | 'waste',
    target: { id: string; version: number },
    path: 'approve' | 'receive',
  ) =>
    request(server())
      .post(`/api/v1/staff/${kind}/${target.id}/${path}`)
      .set(as(actor))
      .send({ version: target.version });

  /** The Approvals screen as `actor` sees it, Pending view. */
  async function approvals(actor: Actor) {
    return (
      await request(server())
        .get('/api/v1/staff/approvals')
        .set(as(actor))
        .expect(200)
    ).body as {
      purchases: { data: Purchase[] };
      waste: { data: Waste[] };
      standing: { approvedTodayKobo: number };
    };
  }

  async function requestAndIssue(
    stockItemId: string,
    packs: number,
  ): Promise<{ number: string }> {
    const asked = (
      await request(server())
        .post('/api/v1/staff/stock/requests')
        .set(as('kitchen'))
        .set('Idempotency-Key', randomUUID())
        .send({ stockItemId, qty: packs, note: 'Dinner preparation' })
        .expect(201)
    ).body as StockRequest;

    expect(asked.status).toBe(StockRequestStatus.PENDING);

    await request(server())
      .post(`/api/v1/staff/stock/requests/${asked.id}/issue`)
      .set(as('storekeeper'))
      .send({ version: asked.version, qty: packs })
      .expect(200);

    return asked;
  }

  async function logWaste(actor: Actor, stockItemId: string): Promise<Waste> {
    return (
      await request(server())
        .post('/api/v1/staff/waste')
        .set(as(actor))
        .set('Idempotency-Key', randomUUID())
        .send({
          location: StockLocation.KITCHEN,
          stockItemId,
          qty: 1,
          reason: WasteReason.SPOILED,
        })
        .expect(201)
    ).body as Waste;
  }

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

  it('1. the Storekeeper raises a purchase above ₦50,000; the Manager’s approval is refused with the Owner Approval Limit message, and the Owner approves', async () => {
    // Two bags of rice at ₦70,000 a bag: ₦140,000.
    gate = await raise(rice.id, 2, 7_000_000);
    expect(gate).toMatchObject({
      status: PurchaseStatus.PENDING,
      totalKobo: 14_000_000,
    });

    // The Manager's Approvals screen says it awaits the Owner, and why.
    const desk = await approvals('manager');
    expect(desk.purchases.data.map((p) => [p.number, p.awaiting])).toEqual([
      [
        gate.number,
        {
          awaits: 'OWNER',
          valueKobo: 14_000_000,
          readerMayApprove: false,
          refusal:
            'This purchase is above the Owner Approval Limit of ₦50,000. The Owner must approve it.',
        },
      ],
    ]);

    const refused = await decide('manager', 'purchases', gate, 'approve');
    expect(refused.status).toBe(403);
    expect(messageOf(refused)).toBe(
      'This purchase is above the Owner Approval Limit of ₦50,000. The Owner must approve it.',
    );

    const approved = await decide('owner', 'purchases', gate, 'approve');
    expect(approved.status).toBe(200);
    gate = approved.body as Purchase;
    expect(gate.status).toBe(PurchaseStatus.APPROVED);
    expect((await approvals('manager')).purchases.data).toEqual([]);
  });

  it('2. the receive task appears for the Storekeeper', async () => {
    const bell = await readBell(server(), as('storekeeper'));

    expect(bell.data).toContainEqual(
      expect.objectContaining({
        title: 'Assigned Task · Open',
        detail: `Receive goods for ${gate.number}`,
        page: 'tasks',
      }),
    );

    const tasks = (
      await request(server())
        .get('/api/v1/staff/tasks')
        .set(as('storekeeper'))
        .expect(200)
    ).body as { data: { title: string; status: TaskStatus }[] };
    expect(tasks.data).toContainEqual(
      expect.objectContaining({
        title: `Receive goods for ${gate.number}`,
        status: TaskStatus.OPEN,
      }),
    );
  });

  it('3. receiving raises Store stock', async () => {
    expect(await balance(rice.id, StockLocation.STORE)).toBe(0);

    const received = await decide('storekeeper', 'purchases', gate, 'receive');
    expect(received.status).toBe(200);
    expect(received.body).toMatchObject({
      purchase: { status: PurchaseStatus.FULFILLED },
      storeQty: { [rice.id]: 2 },
    });
    expect(await balance(rice.id, StockLocation.STORE)).toBe(2);

    // The receive task is done.
    expect(
      await prisma.task.count({
        where: { purchaseId: gate.id, status: { not: TaskStatus.DONE } },
      }),
    ).toBe(0);
  });

  it('4. the kitchen requests 2 bags of rice and the Storekeeper issues them: Store −2, Kitchen +100', async () => {
    const asked = await requestAndIssue(rice.id, 2);

    expect(await balance(rice.id, StockLocation.STORE)).toBe(0);
    expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(100);

    const moves = await prisma.stockMovement.findMany({
      where: { ref: asked.number },
      select: { location: true, qty: true, type: true },
    });
    expect(moves).toEqual(
      expect.arrayContaining([
        {
          location: StockLocation.STORE,
          qty: -2,
          type: StockMovementType.ISSUE_TO_KITCHEN,
        },
        {
          location: StockLocation.KITCHEN,
          qty: 100,
          type: StockMovementType.STOCK_RECEIVED,
        },
      ]),
    );
    expect(moves).toHaveLength(2);
  });

  it('5. a manager cannot approve their own waste entry', async () => {
    // One portion of rice, ₦1,400, logged by the Manager.
    const own = await logWaste('manager', rice.id);
    expect(own.valueKobo).toBe(140_000);

    const desk = await approvals('manager');
    expect(desk.waste.data.find((w) => w.id === own.id)?.awaiting).toEqual({
      awaits: 'MANAGER',
      valueKobo: 140_000,
      readerMayApprove: false,
      refusal:
        'You cannot approve a waste entry you created. The Owner or another manager must approve it.',
    });

    const refused = await decide('manager', 'waste', own, 'approve');
    expect(refused.status).toBe(403);
    expect(messageOf(refused)).toBe(
      'You cannot approve a waste entry you created. The Owner or another manager must approve it.',
    );
    expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(100);

    // Another manager may approve it.
    const approved = await decide('manager2', 'waste', own, 'approve');
    expect(approved.status).toBe(200);
    expect((approved.body as Waste).status).toBe(WasteStatus.APPROVED);
    expect(await balance(rice.id, StockLocation.KITCHEN)).toBe(99);
  });

  it('6. the Daily Approval Limit refuses the approval that crosses ₦150,000', async () => {
    // Four cartons of steak bought (₦160,000, so the Owner approves),
    // received and sent to the Kitchen.
    const steakBuy = await raise(steak.id, 4, 4_000_000);
    const bought = (
      await decide('owner', 'purchases', steakBuy, 'approve').expect(200)
    ).body as Purchase;
    await decide('storekeeper', 'purchases', bought, 'receive').expect(200);
    await requestAndIssue(steak.id, 4);
    expect(await balance(steak.id, StockLocation.KITCHEN)).toBe(4);

    const entries: Waste[] = [];
    for (let i = 0; i < 4; i += 1) {
      entries.push(await logWaste('kitchen', steak.id));
    }
    expect(entries.map((e) => e.valueKobo)).toEqual([
      4_000_000, 4_000_000, 4_000_000, 4_000_000,
    ]);

    // The Manager approves three: ₦120,000 today.
    for (const entry of entries.slice(0, 3)) {
      await decide('manager', 'waste', entry, 'approve').expect(200);
    }
    expect((await approvals('manager')).standing.approvedTodayKobo).toBe(
      12_000_000,
    );

    const sentence =
      'This would take your approvals today to ₦160,000, above the Daily Approval Limit of ₦150,000. The Owner must approve it.';
    const desk = await approvals('manager');
    expect(
      desk.waste.data.find((w) => w.id === entries[3].id)?.awaiting,
    ).toMatchObject({ readerMayApprove: false, refusal: sentence });

    const refused = await decide('manager', 'waste', entries[3], 'approve');
    expect(refused.status).toBe(403);
    expect(messageOf(refused)).toBe(sentence);

    // Nothing moved and nothing more was counted.
    expect(await balance(steak.id, StockLocation.KITCHEN)).toBe(1);
    expect(
      await prisma.approvalLedger.count({ where: { ref: entries[3].number } }),
    ).toBe(0);

    // The Owner approves it.
    await decide('owner', 'waste', entries[3], 'approve').expect(200);
    expect(await balance(steak.id, StockLocation.KITCHEN)).toBe(0);
  });

  it('7. the QR scan checks a person in, then out', async () => {
    const card = await prisma.staff.findUniqueOrThrow({
      where: { id: staffId.kitchen },
      select: { staffNo: true, qrToken: true },
    });
    const code = staffQrPayload(card.staffNo, card.qrToken);
    const scan = () =>
      request(server())
        .post('/api/v1/staff/attendance/scan')
        .set(as('reception'))
        .send({ code });

    const arrived = await scan().expect(200);
    expect(arrived.body).toMatchObject({
      action: 'CHECKED_IN',
      staffId: staffId.kitchen,
      name: 'Gate kitchen',
    });
    // The token the scanner read is never answered back.
    expect(JSON.stringify(arrived.body)).not.toContain(card.qrToken);

    // Eight hours later, well past the one-minute repeat window.
    jest.setSystemTime(Date.now() + 8 * 60 * 60 * 1000);
    await mintTokens();

    const left = await scan().expect(200);
    expect(left.body).toMatchObject({
      action: 'CHECKED_OUT',
      staffId: staffId.kitchen,
    });

    const shifts = await prisma.attendanceRecord.findMany({
      where: { staffId: staffId.kitchen },
      select: { timeIn: true, timeOut: true },
    });
    expect(shifts).toHaveLength(1);
    expect(shifts[0].timeOut).not.toBeNull();
  });
});
