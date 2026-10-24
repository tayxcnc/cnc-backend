const PAYSTACK_KEY = 'sk_test_cnc_staff_bell_e2e_not_a_real_key';

process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CheckoutStatus,
  Department,
  OrderStatus,
  PurchaseStatus,
  ReservationSource,
  ReservationStatus,
  StaffRole,
  StockKind,
  StockLocation,
  StockRequestStatus,
  TableSessionStatus,
  TaskStatus,
  TaskType,
  WasteReason,
  WasteStatus,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import {
  activeOnlineOrderItem,
  checkoutAttentionItem,
  newWebDocketItem,
} from '../src/online-orders/online-bell-items';
import { WebhookDispatcherService } from '../src/payments/webhook-dispatcher.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { pagesFor } from '../src/shell/staff-pages';
import { createTestApp } from './create-test-app';
import { fakeDateOnly } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { chargeSuccessBody, postSignedWebhook } from './paystack-webhooks';
import { type BellItem, readBell } from './staff-bell';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * The staff bell (card C8-2, plan §9.1): every item the demo's
 * `staffNotifications` makes, for the roles it names, behind its alert
 * switch, in the demo's order and words, beside the items built before
 * (the online orders' three, the Free Table Reminder, assigned tasks).
 *
 * On a database of its own with the real seeds and a fixed clock, because
 * the bell reads the whole database: another suite's pending purchase or
 * open bill would be on it. The seeded Bar items are given one pack at
 * the Store and a reorder level of zero, so only this suite's stock
 * items are low.
 *
 * Now is 12:00 in Jos on Wednesday 21 October 2026.
 */
describe('Staff bell (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let dispatcher: WebhookDispatcherService;

  const T = '2026-10-21';
  const NOW = Date.parse('2026-10-21T11:00:00.000Z');
  const HOUR = 60 * 60 * 1000;
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  /** `minutes` before now, for rows whose order matters. */
  const ago = (minutes: number) => new Date(NOW - minutes * 60 * 1000);

  const ROLES = [
    StaffRole.OWNER,
    StaffRole.MANAGER,
    StaffRole.RECEPTION,
    StaffRole.CASHIER,
    StaffRole.WAITER,
    StaffRole.BARTENDER,
    StaffRole.KITCHEN,
    StaffRole.STOREKEEPER,
  ];
  const token: Partial<Record<StaffRole, string>> = {};
  const staffId: Partial<Record<StaffRole, string>> = {};
  const auth = (role: StaffRole) => ({
    Authorization: `Bearer ${token[role]}`,
  });
  const server = () => app.getHttpServer();
  const bell = async (role: StaffRole) =>
    (await readBell(server(), auth(role))).data;

  /** Every expected item, by a short name. */
  const item: Record<string, BellItem> = {};

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    dispatcher = app.get(WebhookDispatcherService, { strict: false });
    await seedData(prisma);

    fakeDateOnly(NOW);

    const tokens = app.get(CncTokenService, { strict: false });

    for (const role of ROLES) {
      const account = await createStaffAccount(prisma, role, {
        name: `Bell ${role.toLowerCase()}`,
      });

      staffId[role] = account.id;
      token[role] = await accessTokenFor(tokens, account.id);
    }

    // The seeded Bar items hold no stock, so each would ring twice.
    const seeded = await prisma.stockItem.findMany({ select: { id: true } });

    await prisma.stockItem.updateMany({ data: { minimum: 0 } });
    await prisma.stockBalance.createMany({
      data: seeded.map((one) => ({
        stockItemId: one.id,
        location: StockLocation.STORE,
        qty: 1,
      })),
    });

    await seedApprovals();
    await seedStock();
    await seedBills();
    await seedOnline();
    await seedReception();
    await seedTasks();
  }, 180_000);

  afterAll(async () => {
    jest.useRealTimers();
    await dispatcher?.settled();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const ids: Record<string, string> = {};

  async function seedApprovals(): Promise<void> {
    const vendor = await prisma.vendor.create({
      data: { name: 'Bell Vendor', phone: '08030000000' },
    });
    const purchase = (
      number: string,
      status: PurchaseStatus,
      note: string,
      createdAt: Date,
      archived = false,
    ) =>
      prisma.purchase.create({
        data: {
          number,
          vendorId: vendor.id,
          status,
          note,
          archived,
          createdAt,
          createdById: staffId[StaffRole.STOREKEEPER]!,
        },
      });

    const p1 = await purchase(
      'PR-930001',
      PurchaseStatus.PENDING,
      'Rice for the weekend',
      ago(300),
    );
    const p2 = await purchase(
      'PR-930002',
      PurchaseStatus.PENDING,
      '',
      ago(200),
    );
    const p3 = await purchase(
      'PR-930003',
      PurchaseStatus.APPROVED,
      'Already decided',
      ago(250),
    );

    await purchase(
      'PR-930004',
      PurchaseStatus.CANCELLED,
      'Archived',
      ago(240),
      true,
    );
    ids.p1 = p1.id;
    ids.p3 = p3.id;

    item.p1 = {
      id: `purchase:${p1.id}`,
      title: 'Purchase Approval',
      detail: 'PR-930001 · Rice for the weekend',
      page: 'purchasing',
      category: 'Approval',
    };
    item.p2 = {
      id: `purchase:${p2.id}`,
      title: 'Purchase Approval',
      detail: 'PR-930002 · Requisition awaiting review',
      page: 'purchasing',
      category: 'Approval',
    };
  }

  async function seedStock(): Promise<void> {
    const stockItem = async (
      name: string,
      kind: StockKind,
      unit: string,
      pack: string,
      minimum: number,
      balances: [StockLocation, number][],
      createdAt: Date,
    ) => {
      const created = await prisma.stockItem.create({
        data: { name, kind, unit, pack, factor: 10, minimum, createdAt },
      });

      for (const [location, qty] of balances) {
        await prisma.stockBalance.create({
          data: { stockItemId: created.id, location, qty },
        });
      }

      return created.id;
    };

    // Out at the Store, under its level in the Kitchen: two items.
    const rice = await stockItem(
      'Bell rice',
      StockKind.KITCHEN,
      'portion',
      'bag',
      5,
      [[StockLocation.KITCHEN, 3]],
      ago(30),
    );
    // Exactly at both lines: not low.
    await stockItem(
      'Bell beans',
      StockKind.KITCHEN,
      'portion',
      'tray',
      5,
      [
        [StockLocation.STORE, 1],
        [StockLocation.KITCHEN, 5],
      ],
      ago(20),
    );
    // A Bar item is a menu item's pair, so a seeded one stands in, added
    // last. One pack at the Store is stock; one bottle at the Bar is
    // under 4.
    const lager = (
      await prisma.stockItem.findFirstOrThrow({
        where: { kind: StockKind.BAR },
        orderBy: { id: 'asc' },
        select: { id: true },
      })
    ).id;

    await prisma.stockItem.update({
      where: { id: lager },
      data: {
        name: 'Bell lager',
        unit: 'bottle',
        pack: 'crate',
        minimum: 4,
        createdAt: ago(10),
      },
    });
    await prisma.stockBalance.create({
      data: { stockItemId: lager, location: StockLocation.BAR, qty: 1 },
    });

    ids.rice = rice;
    item.riceStore = {
      id: `low:${rice}:STORE`,
      title: 'Low Stock · Store',
      detail: 'Bell rice · 0 bags left',
      page: 'inventory',
      category: 'Stock',
    };
    item.riceKitchen = {
      id: `low:${rice}:KITCHEN`,
      title: 'Low Stock · Kitchen',
      detail: 'Bell rice · 3 portions left, reorder level 5',
      page: 'inventory',
      category: 'Stock',
    };
    item.lagerBar = {
      id: `low:${lager}:BAR`,
      title: 'Low Stock · Bar',
      detail: 'Bell lager · 1 bottle left, reorder level 4',
      page: 'inventory',
      category: 'Stock',
    };

    const waste = (number: string, status: WasteStatus, createdAt: Date) =>
      prisma.wasteEntry.create({
        data: {
          number,
          location: StockLocation.KITCHEN,
          stockItemId: rice,
          qty: 3,
          reason: WasteReason.SPOILED,
          status,
          valueKobo: 30_000,
          createdAt,
          createdById: staffId[StaffRole.KITCHEN]!,
          decidedById:
            status === WasteStatus.PENDING ? null : staffId[StaffRole.MANAGER],
        },
      });
    const w1 = await waste('W-930001', WasteStatus.PENDING, ago(100));

    await waste('W-930002', WasteStatus.APPROVED, ago(90));
    item.w1 = {
      id: `waste:${w1.id}`,
      title: 'Waste Approval',
      detail: 'W-930001 · 3 Bell rice · Kitchen',
      page: 'waste',
      category: 'Approval',
    };

    const stockRequest = (
      number: string,
      location: StockLocation,
      stockItemId: string,
      status: StockRequestStatus,
      issuedPacks: number,
      createdAt: Date,
    ) =>
      prisma.stockRequest.create({
        data: {
          number,
          location,
          stockItemId,
          qtyPacks: 3,
          issuedPacks,
          status,
          rejectReason:
            status === StockRequestStatus.REJECTED ? 'None left' : null,
          createdAt,
          createdById: staffId[StaffRole.KITCHEN]!,
        },
      });
    const r1 = await stockRequest(
      'SR-930001',
      StockLocation.KITCHEN,
      rice,
      StockRequestStatus.PENDING,
      0,
      ago(80),
    );
    const r2 = await stockRequest(
      'SR-930002',
      StockLocation.BAR,
      lager,
      StockRequestStatus.PARTIALLY_ISSUED,
      1,
      ago(70),
    );

    await stockRequest(
      'SR-930003',
      StockLocation.KITCHEN,
      rice,
      StockRequestStatus.ISSUED,
      3,
      ago(60),
    );
    await stockRequest(
      'SR-930004',
      StockLocation.KITCHEN,
      rice,
      StockRequestStatus.REJECTED,
      0,
      ago(50),
    );
    item.r1 = {
      id: `request:${r1.id}`,
      title: 'Stock Request',
      detail: 'SR-930001 · Kitchen',
      page: 'inventory',
      category: 'Stock',
    };
    item.r2 = {
      id: `request:${r2.id}`,
      title: 'Stock Request',
      detail: 'SR-930002 · Bar',
      page: 'inventory',
      category: 'Stock',
    };
  }

  async function seedBills(): Promise<void> {
    const bill = (
      number: string,
      department: Department,
      label: string,
      on: string,
      status: OrderStatus,
      createdAt: Date,
    ) =>
      prisma.order.create({
        data: {
          number,
          department,
          label,
          businessDate: day(on),
          status,
          settledAt: status === OrderStatus.SETTLED ? createdAt : null,
          vatBps: 750,
          serviceBps: 0,
          createdAt,
          openedById: staffId[StaffRole.CASHIER],
        },
      });

    // Created in this order: the bell lists them oldest first.
    const u2 = await bill(
      'CNCB-930002',
      Department.BAR,
      'Bar walk-in',
      '2026-10-19',
      OrderStatus.PAYMENT,
      new Date('2026-10-19T19:00:00.000Z'),
    );
    const u1 = await bill(
      'CNCR-930001',
      Department.RESTAURANT,
      'Booth 1',
      '2026-10-20',
      OrderStatus.OPEN,
      // 23:30 in Jos on the 20th: still the 20th's bill.
      new Date('2026-10-20T22:30:00.000Z'),
    );

    // Today's open bill, and earlier bills that are settled or cancelled.
    await bill(
      'CNCR-930003',
      Department.RESTAURANT,
      'Table 4',
      T,
      OrderStatus.OPEN,
      ago(60),
    );
    await bill(
      'CNCR-930004',
      Department.RESTAURANT,
      'Table 5',
      '2026-10-20',
      OrderStatus.SETTLED,
      new Date('2026-10-20T12:00:00.000Z'),
    );
    await bill(
      'CNCR-930005',
      Department.RESTAURANT,
      'Table 6',
      '2026-10-20',
      OrderStatus.CANCELLED,
      new Date('2026-10-20T13:00:00.000Z'),
    );

    item.u2 = {
      id: `unsettled:${u2.id}`,
      title: 'Unsettled From a Previous Day',
      detail: 'CNCB-930002 · Bar walk-in',
      page: 'pos',
      category: 'Payment',
    };
    item.u1 = {
      id: `unsettled:${u1.id}`,
      title: 'Unsettled From a Previous Day',
      detail: 'CNCR-930001 · Booth 1',
      page: 'pos',
      category: 'Payment',
    };
  }

  /**
   * A paid web order (the Cashier's Online Order and the Kitchen's New Web
   * Docket) and a held checkout (the managers' Checkout Needs Attention),
   * through the real checkout and the signed fake webhook.
   */
  async function seedOnline(): Promise<void> {
    const food = await prisma.menuItem.findFirstOrThrow({
      where: {
        active: true,
        showOnline: true,
        department: Department.RESTAURANT,
        choiceOptions: { isEmpty: true },
        priceKobo: { gt: 0 },
      },
      orderBy: { slug: 'asc' },
    });
    const checkout = async () =>
      (
        await request(server())
          .post('/api/v1/checkouts')
          .set('Idempotency-Key', randomUUID())
          .send({
            lines: [{ dishId: food.slug, qty: 1 }],
            fulfilment: 'PICKUP',
            timing: 'ASAP',
            name: 'Ada Okafor',
            phone: '0803 123 4567',
            email: `ada-${randomUUID()}@example.com`,
          })
          .expect(201)
      ).body as { reference: string; sums: { totalKobo: number } };

    const paid = await checkout();

    await postSignedWebhook(
      app,
      chargeSuccessBody(paid.reference, paid.sums.totalKobo),
      PAYSTACK_KEY,
    ).expect(200);

    const held = await checkout();

    await postSignedWebhook(
      app,
      chargeSuccessBody(held.reference, 100),
      PAYSTACK_KEY,
    ).expect(200);
    await dispatcher.settled();

    const online = await prisma.onlineOrder.findUniqueOrThrow({
      where: { paystackReference: paid.reference },
      include: { order: { select: { id: true, number: true } } },
    });
    const docket = await prisma.docket.findFirstOrThrow({
      where: { orderId: online.order.id },
    });
    const attention = await prisma.checkout.findUniqueOrThrow({
      where: { reference: held.reference },
    });

    expect(attention.status).toBe(CheckoutStatus.NEEDS_ATTENTION);
    item.online = activeOnlineOrderItem({
      ...online,
      orderNumber: online.order.number,
    });
    item.docket = newWebDocketItem(docket);
    item.held = checkoutAttentionItem(attention);
  }

  async function seedReception(): Promise<void> {
    const tables = await prisma.diningTable.findMany({
      where: { active: true },
      orderBy: { id: 'asc' },
      take: 6,
      select: { id: true, name: true },
    });
    const booking = (
      tableIndex: number,
      name: string,
      on: string,
      startMinutes: number,
      party: number,
      status: ReservationStatus,
      createdAt: Date,
    ) =>
      prisma.reservation.create({
        data: {
          number: `RSV-93${String(tableIndex).padStart(4, '0')}`,
          tableId: tables[tableIndex].id,
          name,
          phone: '08031111111',
          businessDate: day(on),
          startMinutes,
          party,
          status,
          source: ReservationSource.RECEPTION,
          createdAt,
        },
      });

    // Taken in this order; the later booking is the earlier arrival.
    const a1 = await booking(
      0,
      'Bisi',
      T,
      19 * 60,
      4,
      ReservationStatus.CONFIRMED,
      ago(500),
    );
    const a2 = await booking(
      1,
      'Chidi',
      T,
      13 * 60 + 30,
      1,
      ReservationStatus.CONFIRMED,
      ago(400),
    );

    await booking(
      2,
      'Dayo',
      T,
      12 * 60,
      2,
      ReservationStatus.CHECKED_IN,
      ago(300),
    );
    await booking(
      3,
      'Efe',
      '2026-10-22',
      19 * 60,
      2,
      ReservationStatus.CONFIRMED,
      ago(200),
    );
    item.a1 = {
      id: `arrival:${a1.id}`,
      title: 'Expected Guest Arrival',
      detail: 'Bisi · 19:00 · 4 guests',
      page: 'reception',
      category: 'Reception',
    };
    item.a2 = {
      id: `arrival:${a2.id}`,
      title: 'Expected Guest Arrival',
      detail: 'Chidi · 13:30 · 1 guests',
      page: 'reception',
      category: 'Reception',
    };

    // Seated four hours ago (due), and one hour ago (not yet).
    const seated = await prisma.tableSession.create({
      data: {
        tableId: tables[4].id,
        status: TableSessionStatus.OCCUPIED,
        guest: 'Funmi',
        party: 2,
        since: new Date(NOW - 4 * HOUR),
        openedById: staffId[StaffRole.RECEPTION]!,
      },
    });

    await prisma.tableSession.create({
      data: {
        tableId: tables[5].id,
        status: TableSessionStatus.OCCUPIED,
        guest: 'Gbenga',
        party: 2,
        since: new Date(NOW - HOUR),
        openedById: staffId[StaffRole.RECEPTION]!,
      },
    });
    item.free = {
      id: `free:${tables[4].id}:${seated.since.toISOString()}`,
      title: 'Free Table Reminder',
      detail: `${tables[4].name} · Funmi seated 4 hours ago. Free it if they have left.`,
      page: 'reception',
      category: 'Reception',
    };
  }

  async function seedTasks(): Promise<void> {
    let n = 0;
    const task = async (
      role: StaffRole,
      title: string,
      status: TaskStatus,
      purchaseId?: string,
    ) => {
      n += 1;
      const created = await prisma.task.create({
        data: {
          number: `T-93${String(n).padStart(4, '0')}`,
          title,
          type: purchaseId ? TaskType.PURCHASE : TaskType.GENERAL,
          purchaseId,
          assignedToId: staffId[role]!,
          raisedById: staffId[StaffRole.MANAGER]!,
          status,
          createdAt: ago(1000 - n),
        },
      });

      return {
        id: `task:${created.id}`,
        title: `Assigned Task · ${status === TaskStatus.OPEN ? 'Open' : 'In Progress'}`,
        detail: title,
        page: 'tasks',
        category: 'Task',
      };
    };

    item.managerTask = await task(
      StaffRole.MANAGER,
      'Count the float',
      TaskStatus.OPEN,
    );
    item.managerReview = await task(
      StaffRole.MANAGER,
      'Review purchase PR-930001 from Bell Vendor',
      TaskStatus.OPEN,
      ids.p1,
    );
    item.managerReceive = await task(
      StaffRole.MANAGER,
      'Receive goods for PR-930003',
      TaskStatus.IN_PROGRESS,
      ids.p3,
    );
    await task(StaffRole.MANAGER, 'Done already', TaskStatus.DONE);
    item.cashierTask = await task(
      StaffRole.CASHIER,
      'Check the till roll',
      TaskStatus.OPEN,
    );
    item.storeTask = await task(
      StaffRole.STOREKEEPER,
      'Tidy the store',
      TaskStatus.IN_PROGRESS,
    );
    item.receptionTask = await task(
      StaffRole.RECEPTION,
      'Water the plants',
      TaskStatus.OPEN,
    );
    item.kitchenTask = await task(
      StaffRole.KITCHEN,
      'Clean the grill',
      TaskStatus.OPEN,
    );
    // A Waiter cannot open Tasks: an account whose role changed may still
    // hold a task, which its bell must not offer.
    await task(StaffRole.WAITER, 'Left from another role', TaskStatus.OPEN);
  }

  async function alerts(
    data: Partial<{
      alertApprovals: boolean;
      alertLowStock: boolean;
      alertUnsettled: boolean;
      alertArrivals: boolean;
    }>,
  ): Promise<void> {
    await prisma.settings.update({ where: { singleton: true }, data });
  }

  const ALL_ON = {
    alertApprovals: true,
    alertLowStock: true,
    alertUnsettled: true,
    alertArrivals: true,
  };

  afterEach(() => alerts(ALL_ON));

  /** Each role's bell with every switch on, in the order it must come. */
  const expected = (): Record<StaffRole, BellItem[]> => {
    const managers = [
      item.p1,
      item.p2,
      item.w1,
      item.riceStore,
      item.riceKitchen,
      item.lagerBar,
      item.u2,
      item.u1,
      item.docket,
      item.held,
      item.free,
      item.a1,
      item.a2,
    ];

    return {
      [StaffRole.OWNER]: managers,
      // The review task is left out: the Purchase Approval asks for it.
      [StaffRole.MANAGER]: [...managers, item.managerTask, item.managerReceive],
      [StaffRole.RECEPTION]: [item.free, item.a1, item.a2, item.receptionTask],
      [StaffRole.CASHIER]: [item.u2, item.u1, item.online, item.cashierTask],
      [StaffRole.WAITER]: [],
      [StaffRole.BARTENDER]: [],
      [StaffRole.KITCHEN]: [item.docket, item.kitchenTask],
      [StaffRole.STOREKEEPER]: [
        item.riceStore,
        item.riceKitchen,
        item.lagerBar,
        item.r1,
        item.r2,
        item.storeTask,
      ],
    };
  };

  describe('with every alert on', () => {
    it.each(ROLES)(
      '%s gets exactly its items, in the demo’s order and words',
      async (role) => {
        const read = await readBell(server(), auth(role));

        expect(read.data).toEqual(expected()[role]);
        expect(read.total).toBe(expected()[role].length);
      },
    );

    it('offers every role only items whose page it can open', async () => {
      for (const role of ROLES) {
        const pages: readonly string[] = pagesFor(role);

        for (const one of await bell(role)) {
          expect(pages).toContain(one.page);
        }
      }
    });
  });

  describe('each alert switch', () => {
    it('approvals off: no Purchase or Waste Approval, and the manager’s review task comes back', async () => {
      await alerts({ alertApprovals: false });

      const managers = expected()[StaffRole.MANAGER].filter(
        (one) => one.category !== 'Approval',
      );

      expect(await bell(StaffRole.OWNER)).toEqual(
        expected()[StaffRole.OWNER].filter(
          (one) => one.category !== 'Approval',
        ),
      );
      expect(await bell(StaffRole.MANAGER)).toEqual([
        ...managers.filter((one) => one.category !== 'Task'),
        item.managerTask,
        item.managerReview,
        item.managerReceive,
      ]);
      // Nobody else's bell carries either.
      for (const role of [StaffRole.STOREKEEPER, StaffRole.CASHIER]) {
        expect(await bell(role)).toEqual(expected()[role]);
      }
    });

    it('low stock off: no Low Stock for managers or the Storekeeper', async () => {
      await alerts({ alertLowStock: false });

      for (const role of [
        StaffRole.OWNER,
        StaffRole.MANAGER,
        StaffRole.STOREKEEPER,
      ]) {
        expect(await bell(role)).toEqual(
          expected()[role].filter((one) => !one.id.startsWith('low:')),
        );
      }
    });

    it('unsettled off: no previous day’s bills for managers or the Cashier', async () => {
      await alerts({ alertUnsettled: false });

      for (const role of [
        StaffRole.OWNER,
        StaffRole.MANAGER,
        StaffRole.CASHIER,
      ]) {
        expect(await bell(role)).toEqual(
          expected()[role].filter((one) => !one.id.startsWith('unsettled:')),
        );
      }
    });

    it('arrivals off: no Expected Guest Arrival for Reception or managers', async () => {
      await alerts({ alertArrivals: false });

      for (const role of [
        StaffRole.OWNER,
        StaffRole.MANAGER,
        StaffRole.RECEPTION,
      ]) {
        expect(await bell(role)).toEqual(
          expected()[role].filter((one) => !one.id.startsWith('arrival:')),
        );
      }
    });

    it('every switch off: the items without a switch stay', async () => {
      await alerts({
        alertApprovals: false,
        alertLowStock: false,
        alertUnsettled: false,
        alertArrivals: false,
      });

      expect(await bell(StaffRole.MANAGER)).toEqual([
        item.docket,
        item.held,
        item.free,
        item.managerTask,
        item.managerReview,
        item.managerReceive,
      ]);
      expect(await bell(StaffRole.CASHIER)).toEqual([
        item.online,
        item.cashierTask,
      ]);
      expect(await bell(StaffRole.STOREKEEPER)).toEqual([
        item.r1,
        item.r2,
        item.storeTask,
      ]);
      expect(await bell(StaffRole.RECEPTION)).toEqual([
        item.free,
        item.receptionTask,
      ]);
      expect(await bell(StaffRole.KITCHEN)).toEqual(
        expected()[StaffRole.KITCHEN],
      );
    });
  });

  describe('the page', () => {
    it('pages across the kinds with an exact total: every page joined is the whole bell', async () => {
      const whole = expected()[StaffRole.MANAGER];
      const joined: BellItem[] = [];

      for (let page = 1; page <= 6; page += 1) {
        const body = (
          await request(server())
            .get('/api/v1/staff/notifications')
            .query({ page, pageSize: 3 })
            .set(auth(StaffRole.MANAGER))
            .expect(200)
        ).body as {
          data: BellItem[];
          page: number;
          pageSize: number;
          total: number;
        };

        expect(body).toMatchObject({ page, pageSize: 3, total: whole.length });
        joined.push(...body.data);
      }

      expect(joined).toEqual(whole);
    });

    it('refuses a page larger than 100, and a reader without a token', async () => {
      await request(server())
        .get('/api/v1/staff/notifications')
        .query({ pageSize: 101 })
        .set(auth(StaffRole.MANAGER))
        .expect(400);
      await request(server()).get('/api/v1/staff/notifications').expect(401);
    });
  });

  describe('items leave when the work is done', () => {
    it('a decided purchase, a settled bill, a checked-in guest and an issued request leave every bell', async () => {
      const purchase = await prisma.purchase.findFirstOrThrow({
        where: { number: 'PR-930002' },
      });
      const unsettled = await prisma.order.findFirstOrThrow({
        where: { number: 'CNCR-930001' },
      });
      const arrival = await prisma.reservation.findFirstOrThrow({
        where: { name: 'Chidi' },
      });
      const requested = await prisma.stockRequest.findFirstOrThrow({
        where: { number: 'SR-930002' },
      });

      await prisma.purchase.update({
        where: { id: purchase.id },
        data: {
          status: PurchaseStatus.REJECTED,
          decidedById: staffId[StaffRole.MANAGER],
        },
      });
      await prisma.order.update({
        where: { id: unsettled.id },
        data: { status: OrderStatus.SETTLED, settledAt: new Date() },
      });
      await prisma.reservation.update({
        where: { id: arrival.id },
        data: { status: ReservationStatus.CHECKED_IN },
      });
      await prisma.stockRequest.update({
        where: { id: requested.id },
        data: { status: StockRequestStatus.ISSUED, issuedPacks: 3 },
      });

      try {
        const gone = [item.p2.id, item.u1.id, item.a2.id, item.r2.id];

        for (const role of ROLES) {
          const onBell = (await bell(role)).map((one) => one.id);

          expect(onBell.filter((id) => gone.includes(id))).toEqual([]);
        }
      } finally {
        await prisma.purchase.update({
          where: { id: purchase.id },
          data: { status: PurchaseStatus.PENDING, decidedById: null },
        });
        await prisma.order.update({
          where: { id: unsettled.id },
          data: { status: OrderStatus.OPEN, settledAt: null },
        });
        await prisma.reservation.update({
          where: { id: arrival.id },
          data: { status: ReservationStatus.CONFIRMED },
        });
        await prisma.stockRequest.update({
          where: { id: requested.id },
          data: { status: StockRequestStatus.PARTIALLY_ISSUED, issuedPacks: 1 },
        });
      }

      // Put back, they ring again.
      expect(await bell(StaffRole.MANAGER)).toEqual(
        expected()[StaffRole.MANAGER],
      );
    });
  });
});
