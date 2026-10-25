import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  CheckoutSource,
  CheckoutStatus,
  CheckoutTiming,
  Department,
  Fulfilment,
  MaintenanceStatus,
  OnlineOrderMode,
  OrderChannel,
  OrderStatus,
  PaymentMethod,
  PurchaseStatus,
  StaffRole,
  StockKind,
  StockLocation,
  StockMovementType,
  WasteReason,
  WasteStatus,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp } from './create-test-app';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * Reports (card C8-1): Sales, Payments Received, Daily Transfers, Stock
 * Movements, Waste, Maintenance History and Vendor Spend, with exact
 * figures, who may read each, and ranges that meet a Lagos midnight.
 *
 * On a database of its own with the real seeds: every report sums the
 * whole range, so another suite's bill or payment in the shared database
 * would move the figures. The records are written directly, at chosen
 * instants either side of a Jos midnight, because the commands that make
 * them stamp the server's clock; how the commands write them is their own
 * suites' business, and this suite is about how the reports read them.
 *
 * Two Lagos days in March 2026: D1 = 10 March, D2 = 11 March. 22:30Z on
 * D1 is 23:30 in Jos on D1; 23:30Z on D1 is 00:30 in Jos on D2.
 */
describe('Reports (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  const D1 = '2026-03-10';
  const D2 = '2026-03-11';
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const at = (iso: string) => new Date(iso);

  const token: Partial<Record<StaffRole, string>> = {};
  const staffId: Partial<Record<StaffRole, string>> = {};

  let food: { id: string; name: string; category: string };
  let drink: { id: string; name: string; category: string };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    await seedData(prisma);

    const tokens = app.get(CncTokenService, { strict: false });

    for (const role of [
      StaffRole.OWNER,
      StaffRole.MANAGER,
      StaffRole.CASHIER,
      StaffRole.WAITER,
      StaffRole.BARTENDER,
      StaffRole.STOREKEEPER,
      StaffRole.RECEPTION,
      StaffRole.KITCHEN,
    ]) {
      const account = await createStaffAccount(prisma, role);

      staffId[role] = account.id;
      token[role] = await accessTokenFor(tokens, account.id);
    }

    const dish = async (department: Department) => {
      const item = await prisma.menuItem.findFirstOrThrow({
        where: { department, active: true },
        orderBy: { slug: 'asc' },
        select: {
          id: true,
          name: true,
          staffCategory: { select: { name: true } },
        },
      });

      return {
        id: item.id,
        name: item.name,
        category: item.staffCategory.name,
      };
    };

    food = await dish(Department.RESTAURANT);
    drink = await dish(Department.BAR);

    await seedRecords();
  }, 180_000);

  afterAll(async () => {
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  /** A settled or open bill with its lines, as the till or a payment leaves it. */
  async function bill(input: {
    number: string;
    department: Department;
    channel?: OrderChannel;
    openedOn: string;
    status: OrderStatus;
    settledAt?: Date;
    serviceBps?: number;
    discountKobo?: number;
    lines: {
      menuItemId: string;
      department: Department;
      qty: number;
      unitPriceKobo: number;
    }[];
  }): Promise<string> {
    const order = await prisma.order.create({
      data: {
        number: input.number,
        department: input.department,
        channel: input.channel ?? OrderChannel.POS,
        label: 'Report test',
        businessDate: day(input.openedOn),
        status: input.status,
        settledAt: input.settledAt ?? null,
        vatBps: 750,
        serviceBps: input.serviceBps ?? 0,
        discountKobo: input.discountKobo ?? 0,
        openedById:
          input.channel === OrderChannel.WEB
            ? null
            : staffId[StaffRole.CASHIER],
      },
    });

    for (const line of input.lines) {
      await prisma.orderLine.create({
        data: { orderId: order.id, name: 'Line', ...line },
      });
    }

    return order.id;
  }

  async function pay(input: {
    number: string;
    orderId: string;
    method: PaymentMethod;
    amountKobo: number;
    on: string;
    at: string;
    part?: boolean;
    reversed?: boolean;
    sender?: string;
    reference?: string;
    staff?: boolean;
  }): Promise<void> {
    await prisma.payment.create({
      data: {
        number: input.number,
        orderId: input.orderId,
        method: input.method,
        amountKobo: input.amountKobo,
        businessDate: day(input.on),
        createdAt: at(input.at),
        part: input.part ?? false,
        reversed: input.reversed ?? false,
        reversedAt: input.reversed ? at(input.at) : null,
        sender: input.sender ?? '',
        reference: input.reference ?? '',
        staffId: input.staff === false ? null : staffId[StaffRole.CASHIER],
      },
    });
  }

  async function seedRecords(): Promise<void> {
    // A: Restaurant, settled 23:30 in Jos on D1, with a discount and
    // service. 2 × ₦5,000 = ₦10,000; less ₦100 is ₦9,900; service 10% is
    // ₦990; VAT 7.5% of ₦10,890 is ₦816.75; total ₦11,706.75.
    ids.a = await bill({
      number: 'CNCR-900001',
      department: Department.RESTAURANT,
      openedOn: D1,
      status: OrderStatus.SETTLED,
      settledAt: at('2026-03-10T22:30:00.000Z'),
      serviceBps: 1000,
      discountKobo: 10_000,
      lines: [
        {
          menuItemId: food.id,
          department: Department.RESTAURANT,
          qty: 2,
          unitPriceKobo: 500_000,
        },
      ],
    });
    // B: Bar, opened on D1 and settled 00:30 in Jos on D2. 3 × ₦2,000 plus
    // VAT is ₦6,450.
    ids.b = await bill({
      number: 'CNCB-900001',
      department: Department.BAR,
      openedOn: D1,
      status: OrderStatus.SETTLED,
      settledAt: at('2026-03-10T23:30:00.000Z'),
      lines: [
        {
          menuItemId: drink.id,
          department: Department.BAR,
          qty: 3,
          unitPriceKobo: 200_000,
        },
      ],
    });
    // C: a web order of one dish and two drinks, paid 11:00 in Jos on D2,
    // ₦9,000 plus VAT ₦675 is ₦9,675, and ₦5,000 delivery outside it.
    ids.c = await bill({
      number: 'CNCR-900002',
      department: Department.RESTAURANT,
      channel: OrderChannel.WEB,
      openedOn: D2,
      status: OrderStatus.SETTLED,
      settledAt: at('2026-03-11T10:00:00.000Z'),
      lines: [
        {
          menuItemId: food.id,
          department: Department.RESTAURANT,
          qty: 1,
          unitPriceKobo: 500_000,
        },
        {
          menuItemId: drink.id,
          department: Department.BAR,
          qty: 2,
          unitPriceKobo: 200_000,
        },
      ],
    });

    const reference = `cnc-order-${randomUUID()}`;
    const checkout = await prisma.checkout.create({
      data: {
        reference,
        source: CheckoutSource.WEB,
        status: CheckoutStatus.PAID,
        expiresAt: at('2026-03-11T10:30:00.000Z'),
        paidAt: at('2026-03-11T10:00:00.000Z'),
        lines: [],
        subtotalKobo: 900_000,
        vatKobo: 67_500,
        deliveryKobo: 500_000,
        totalKobo: 1_467_500,
        vatBps: 750,
        deliveryJosKobo: 500_000,
        deliveryOutsideKobo: 1_000_000,
        fulfilment: Fulfilment.DELIVERY,
        zone: 'JOS',
        contactName: 'Ada Okafor',
        contactPhone: '08031234567',
        contactEmail: 'ada@example.com',
        timing: CheckoutTiming.ASAP,
        timingText: 'As soon as possible',
        ipHash: 'report-test',
        orderId: ids.c,
      },
    });

    await prisma.onlineOrder.create({
      data: {
        number: 'WEB-900001',
        orderId: ids.c,
        checkoutId: checkout.id,
        contactName: 'Ada Okafor',
        contactPhone: '08031234567',
        contactEmail: 'ada@example.com',
        mode: OnlineOrderMode.WITHIN_JOS,
        feeKobo: 500_000,
        deliveryJosKobo: 500_000,
        deliveryOutsideKobo: 1_000_000,
        timingText: 'As soon as possible',
        paystackReference: reference,
      },
    });
    // E: an open Restaurant bill (₦5,375) with ₦1,000 part-paid.
    ids.e = await bill({
      number: 'CNCR-900003',
      department: Department.RESTAURANT,
      openedOn: D1,
      status: OrderStatus.OPEN,
      lines: [
        {
          menuItemId: food.id,
          department: Department.RESTAURANT,
          qty: 1,
          unitPriceKobo: 500_000,
        },
      ],
    });

    await pay({
      number: 'PAY-900001',
      orderId: ids.a,
      method: PaymentMethod.CASH,
      amountKobo: 600_000,
      on: D1,
      at: '2026-03-10T20:00:00.000Z',
      part: true,
    });
    await pay({
      number: 'PAY-900002',
      orderId: ids.a,
      method: PaymentMethod.TRANSFER,
      amountKobo: 570_675,
      on: D1,
      at: '2026-03-10T22:30:00.000Z',
      sender: 'Ada Okafor',
      reference: 'TRF-0001',
    });
    await pay({
      number: 'PAY-900003',
      orderId: ids.b,
      method: PaymentMethod.CARD,
      amountKobo: 645_000,
      on: D2,
      at: '2026-03-10T23:30:00.000Z',
    });
    await pay({
      number: 'PAY-900004',
      orderId: ids.c,
      method: PaymentMethod.ONLINE,
      amountKobo: 1_467_500,
      on: D2,
      at: '2026-03-11T10:00:00.000Z',
      staff: false,
    });
    await pay({
      number: 'PAY-900005',
      orderId: ids.a,
      method: PaymentMethod.CASH,
      amountKobo: 99_999,
      on: D1,
      at: '2026-03-10T21:00:00.000Z',
      reversed: true,
    });
    await pay({
      number: 'PAY-900006',
      orderId: ids.e,
      method: PaymentMethod.CASH,
      amountKobo: 100_000,
      on: D2,
      at: '2026-03-11T12:00:00.000Z',
      part: true,
    });

    // Stock: one movement a minute before a Jos midnight, one a minute after.
    const item = await prisma.stockItem.create({
      data: {
        name: `Report rice ${randomUUID()}`,
        kind: StockKind.KITCHEN,
        unit: 'portion',
        pack: 'bag',
        factor: 10,
        minimum: 1,
      },
    });

    ids.item = item.id;

    for (const [qty, when] of [
      [5, '2026-03-10T22:59:00.000Z'],
      [-2, '2026-03-10T23:01:00.000Z'],
    ] as const) {
      await prisma.stockMovement.create({
        data: {
          stockItemId: item.id,
          location: StockLocation.STORE,
          qty,
          type: StockMovementType.STOCK_COUNT,
          ref: 'Report count',
          staffId: staffId[StaffRole.STOREKEEPER],
          createdAt: at(when),
        },
      });
    }

    // Waste: logged 23:30 on D1 in Jos, and 00:30 on D2.
    for (const [number, when, status] of [
      ['W-900001', '2026-03-10T22:30:00.000Z', WasteStatus.APPROVED],
      ['W-900002', '2026-03-10T23:30:00.000Z', WasteStatus.PENDING],
    ] as const) {
      await prisma.wasteEntry.create({
        data: {
          number,
          location: StockLocation.STORE,
          stockItemId: item.id,
          qty: 1,
          reason: WasteReason.SPOILED,
          status,
          valueKobo: 300_000,
          createdById: staffId[StaffRole.STOREKEEPER]!,
          decidedById:
            status === WasteStatus.APPROVED ? staffId[StaffRole.MANAGER] : null,
          createdAt: at(when),
        },
      });
    }

    // Vendors, in the order they were added; purchases and repairs.
    const v1 = await prisma.vendor.create({
      data: {
        name: 'Jos Grains',
        phone: '08030000001',
        createdAt: at('2026-01-01T09:00:00.000Z'),
      },
    });
    const v2 = await prisma.vendor.create({
      data: {
        name: 'Plateau Cooling',
        phone: '08030000002',
        createdAt: at('2026-01-02T09:00:00.000Z'),
      },
    });

    ids.v1 = v1.id;
    ids.v2 = v2.id;

    const item2 = await prisma.stockItem.create({
      data: {
        name: `Report beans ${randomUUID()}`,
        kind: StockKind.KITCHEN,
        unit: 'portion',
        pack: 'bag',
        factor: 10,
        minimum: 1,
      },
    });
    const purchase = async (
      number: string,
      status: PurchaseStatus,
      when: string,
      lines: {
        stockItemId: string;
        vendorId: string;
        qtyPacks: number;
        costKobo: number;
      }[],
    ) => {
      const row = await prisma.purchase.create({
        data: {
          number,
          vendorId: lines[0].vendorId,
          status,
          createdById: staffId[StaffRole.STOREKEEPER]!,
          createdAt: at(when),
        },
      });

      for (const [position, line] of lines.entries()) {
        await prisma.purchaseLine.create({
          data: {
            purchaseId: row.id,
            position,
            ...line,
            receivedPacks:
              status === PurchaseStatus.FULFILLED ? line.qtyPacks : 0,
          },
        });
      }
    };

    // Raised 23:30 on D1 in Jos: ₦6,000 from V1, ₦1,500 from V2.
    await purchase(
      'PR-900001',
      PurchaseStatus.FULFILLED,
      '2026-03-10T22:30:00.000Z',
      [
        {
          stockItemId: item.id,
          vendorId: v1.id,
          qtyPacks: 2,
          costKobo: 300_000,
        },
        {
          stockItemId: item2.id,
          vendorId: v2.id,
          qtyPacks: 1,
          costKobo: 150_000,
        },
      ],
    );
    // Raised 00:30 on D2: ₦2,000 from V2.
    await purchase(
      'PR-900002',
      PurchaseStatus.FULFILLED,
      '2026-03-10T23:30:00.000Z',
      [
        {
          stockItemId: item.id,
          vendorId: v2.id,
          qtyPacks: 1,
          costKobo: 200_000,
        },
      ],
    );
    // Approved and never received: no spend.
    await purchase(
      'PR-900003',
      PurchaseStatus.APPROVED,
      '2026-03-10T12:00:00.000Z',
      [
        {
          stockItemId: item.id,
          vendorId: v1.id,
          qtyPacks: 9,
          costKobo: 900_000,
        },
      ],
    );

    const asset = await prisma.asset.create({
      data: {
        tag: `RPT-${randomUUID().slice(0, 8)}`,
        name: 'Walk-in chiller',
        quantity: 1,
      },
    });

    ids.asset = asset.id;

    await prisma.maintenanceRecord.create({
      data: {
        number: 'MT-900001',
        assetId: asset.id,
        vendorId: v1.id,
        description: 'Not cooling',
        costKobo: 250_000,
        reportedOn: day(D1),
        status: MaintenanceStatus.PENDING,
        createdAt: at('2026-03-10T09:00:00.000Z'),
      },
    });
    await prisma.maintenanceRecord.create({
      data: {
        number: 'MT-900002',
        assetId: asset.id,
        vendorId: v1.id,
        description: 'Door seal',
        costKobo: 100_000,
        reportedOn: day(D2),
        resolvedOn: day(D2),
        status: MaintenanceStatus.FIXED,
        createdAt: at('2026-03-11T09:00:00.000Z'),
      },
    });
  }

  const server = () => app.getHttpServer();
  const get = (role: StaffRole, path: string) =>
    request(server())
      .get(`/api/v1/staff/reports/${path}`)
      .set({ Authorization: `Bearer ${token[role]!}` });
  const body = async <T>(role: StaffRole, path: string): Promise<T> =>
    (await get(role, path).expect(200)).body as T;

  interface SalesBody {
    data: {
      number: string;
      department: Department;
      departments: Department[];
      openedOn: string;
      settledOn: string;
      netItemsKobo: number;
      vatKobo: number;
      serviceKobo: number;
      totalKobo: number;
    }[];
    total: number;
    from: string;
    to: string;
    completedSalesKobo: number;
    settledBills: number;
    departments: { department: Department; totalKobo: number; bills: number }[];
    vatKobo: number;
    serviceKobo: number;
    stillOwedKobo: number;
    openBills: number;
    deliveryFeesKobo: number;
    deliveryOrders: number;
    byItem: {
      menuItemId: string;
      name: string;
      category: string;
      qty: number;
      salesKobo: number;
    }[];
    byCategory: { category: string; qty: number; salesKobo: number }[];
  }

  describe('Sales', () => {
    it('reads the bills settled in the range by their Lagos settlement date, with every figure', async () => {
      const sales = await body<SalesBody>(
        StaffRole.MANAGER,
        `sales?from=${D1}&to=${D2}`,
      );

      expect(sales.data).toEqual([
        {
          orderId: ids.a,
          number: 'CNCR-900001',
          department: Department.RESTAURANT,
          channel: OrderChannel.POS,
          departments: [Department.RESTAURANT],
          openedOn: D1,
          settledOn: D1,
          settledAt: '2026-03-10T22:30:00.000Z',
          netItemsKobo: 990_000,
          vatKobo: 81_675,
          serviceKobo: 99_000,
          totalKobo: 1_170_675,
        },
        {
          orderId: ids.b,
          number: 'CNCB-900001',
          department: Department.BAR,
          channel: OrderChannel.POS,
          departments: [Department.BAR],
          openedOn: D1,
          settledOn: D2,
          settledAt: '2026-03-10T23:30:00.000Z',
          netItemsKobo: 600_000,
          vatKobo: 45_000,
          serviceKobo: 0,
          totalKobo: 645_000,
        },
        {
          orderId: ids.c,
          number: 'CNCR-900002',
          department: Department.RESTAURANT,
          channel: OrderChannel.WEB,
          departments: [Department.RESTAURANT, Department.BAR],
          openedOn: D2,
          settledOn: D2,
          settledAt: '2026-03-11T10:00:00.000Z',
          netItemsKobo: 900_000,
          vatKobo: 67_500,
          serviceKobo: 0,
          totalKobo: 967_500,
        },
      ]);
      expect(sales).toMatchObject({
        total: 3,
        from: D1,
        to: D2,
        completedSalesKobo: 2_783_175,
        settledBills: 3,
        // The web order's drinks are the Bar's: ₦4,000 + VAT = ₦4,300.
        departments: [
          {
            department: Department.RESTAURANT,
            totalKobo: 1_708_175,
            bills: 2,
          },
          { department: Department.BAR, totalKobo: 1_075_000, bills: 2 },
        ],
        vatKobo: 194_175,
        serviceKobo: 99_000,
        // The open bill: ₦5,375 less ₦1,000 part-paid.
        stillOwedKobo: 437_500,
        openBills: 1,
        // Q21: the delivery fee is its own line, outside the sales.
        deliveryFeesKobo: 500_000,
        deliveryOrders: 1,
      });
      expect(sales.byItem).toEqual([
        {
          menuItemId: food.id,
          name: food.name,
          category: food.category,
          department: Department.RESTAURANT,
          qty: 3,
          salesKobo: 1_500_000,
        },
        {
          menuItemId: drink.id,
          name: drink.name,
          category: drink.category,
          department: Department.BAR,
          qty: 5,
          salesKobo: 1_000_000,
        },
      ]);
      expect(sales.byCategory).toEqual([
        { category: food.category, qty: 3, salesKobo: 1_500_000 },
        { category: drink.category, qty: 5, salesKobo: 1_000_000 },
      ]);
    });

    it('puts a bill settled at 00:30 in Jos on the next day', async () => {
      const first = await body<SalesBody>(
        StaffRole.MANAGER,
        `sales?from=${D1}&to=${D1}`,
      );
      const second = await body<SalesBody>(
        StaffRole.MANAGER,
        `sales?from=${D2}&to=${D2}`,
      );

      expect(first.data.map((row) => row.number)).toEqual(['CNCR-900001']);
      expect(first.completedSalesKobo).toBe(1_170_675);
      expect(first.deliveryFeesKobo).toBe(0);
      expect(second.data.map((row) => row.number)).toEqual([
        'CNCB-900001',
        'CNCR-900002',
      ]);
      expect(second.completedSalesKobo).toBe(1_612_500);
    });

    it('takes a department from each line, so the web order’s drinks are the Bar’s', async () => {
      const bar = await body<SalesBody>(
        StaffRole.MANAGER,
        `sales?from=${D1}&to=${D2}&department=BAR`,
      );

      expect(
        bar.data.map((row) => [
          row.number,
          row.netItemsKobo,
          row.vatKobo,
          row.totalKobo,
        ]),
      ).toEqual([
        ['CNCB-900001', 600_000, 45_000, 645_000],
        ['CNCR-900002', 400_000, 30_000, 430_000],
      ]);
      expect(bar).toMatchObject({
        completedSalesKobo: 1_075_000,
        settledBills: 2,
        departments: [
          { department: Department.RESTAURANT, totalKobo: 0, bills: 0 },
          { department: Department.BAR, totalKobo: 1_075_000, bills: 2 },
        ],
        vatKobo: 75_000,
        stillOwedKobo: 0,
        openBills: 0,
      });
      expect(bar.byItem.map((row) => [row.menuItemId, row.qty])).toEqual([
        [drink.id, 5],
      ]);

      const restaurant = await body<SalesBody>(
        StaffRole.MANAGER,
        `sales?from=${D1}&to=${D2}&department=RESTAURANT`,
      );

      expect(restaurant.completedSalesKobo).toBe(1_708_175);
      expect(restaurant.stillOwedKobo).toBe(437_500);
      expect(
        restaurant.data.find((row) => row.number === 'CNCR-900002'),
      ).toMatchObject({
        netItemsKobo: 500_000,
        vatKobo: 37_500,
        totalKobo: 537_500,
      });
    });

    it('pages the bills and keeps the figures for the whole range', async () => {
      const page = await body<SalesBody>(
        StaffRole.MANAGER,
        `sales?from=${D1}&to=${D2}&page=2&pageSize=2`,
      );

      expect(page.data.map((row) => row.number)).toEqual(['CNCR-900002']);
      expect(page).toMatchObject({ total: 3, completedSalesKobo: 2_783_175 });
    });

    it('refuses a bad department or range in one sentence', async () => {
      const department = await get(
        StaffRole.MANAGER,
        `sales?from=${D1}&to=${D2}&department=KITCHEN`,
      ).expect(400);

      expect((department.body as { message: unknown }).message).toEqual([
        'Choose a department.',
      ]);

      const backwards = await get(
        StaffRole.MANAGER,
        `sales?from=${D2}&to=${D1}`,
      ).expect(400);

      expect((backwards.body as { message: unknown }).message).toBe(
        'to must not be before from.',
      );
      await get(StaffRole.MANAGER, `sales?from=2026-02-30`).expect(400);
      await get(StaffRole.MANAGER, `sales?from=2025-01-01&to=${D2}`).expect(
        400,
      );
    });
  });

  interface PaymentsBody {
    data: {
      number: string;
      orderNumber: string;
      method: PaymentMethod;
      kind: string;
      amountKobo: number;
      businessDate: string;
      at: string;
      sender: string;
      reference: string;
      staffName: string | null;
    }[];
    total: number;
    receivedKobo: number;
    payments: number;
    partKobo: number;
    partPayments: number;
    methods: { method: PaymentMethod; amountKobo: number; payments: number }[];
  }

  describe('Payments Received', () => {
    it('reads every non-reversed payment dated in the range, newest first, with its kind', async () => {
      const report = await body<PaymentsBody>(
        StaffRole.CASHIER,
        `payments?from=${D1}&to=${D2}`,
      );

      expect(
        report.data.map((row) => [
          row.number,
          row.orderNumber,
          row.method,
          row.kind,
          row.amountKobo,
        ]),
      ).toEqual([
        [
          'PAY-900006',
          'CNCR-900003',
          PaymentMethod.CASH,
          'PART_PAYMENT',
          100_000,
        ],
        [
          'PAY-900004',
          'CNCR-900002',
          PaymentMethod.ONLINE,
          'ONLINE_CHECKOUT',
          1_467_500,
        ],
        [
          'PAY-900003',
          'CNCB-900001',
          PaymentMethod.CARD,
          'FINAL_PAYMENT',
          645_000,
        ],
        [
          'PAY-900002',
          'CNCR-900001',
          PaymentMethod.TRANSFER,
          'FINAL_PAYMENT',
          570_675,
        ],
        [
          'PAY-900001',
          'CNCR-900001',
          PaymentMethod.CASH,
          'PART_PAYMENT',
          600_000,
        ],
      ]);
      expect(report.data[1].staffName).toBeNull();
      expect(report).toMatchObject({
        total: 5,
        receivedKobo: 3_383_175,
        payments: 5,
        partKobo: 700_000,
        partPayments: 2,
        methods: [
          { method: PaymentMethod.CASH, amountKobo: 700_000, payments: 2 },
          { method: PaymentMethod.CARD, amountKobo: 645_000, payments: 1 },
          { method: PaymentMethod.TRANSFER, amountKobo: 570_675, payments: 1 },
          { method: PaymentMethod.ONLINE, amountKobo: 1_467_500, payments: 1 },
        ],
      });
    });

    it('dates a payment taken at 00:30 in Jos on that day', async () => {
      const first = await body<PaymentsBody>(
        StaffRole.MANAGER,
        `payments?from=${D1}&to=${D1}`,
      );
      const second = await body<PaymentsBody>(
        StaffRole.MANAGER,
        `payments?from=${D2}&to=${D2}`,
      );

      expect(first.data.map((row) => row.number)).toEqual([
        'PAY-900002',
        'PAY-900001',
      ]);
      expect(first.receivedKobo).toBe(1_170_675);
      expect(second.data.map((row) => row.number)).toEqual([
        'PAY-900006',
        'PAY-900004',
        'PAY-900003',
      ]);
      expect(second.receivedKobo).toBe(2_212_500);
    });

    it('pages newest first', async () => {
      const page = await body<PaymentsBody>(
        StaffRole.MANAGER,
        `payments?from=${D1}&to=${D2}&page=2&pageSize=2`,
      );

      expect(page.data.map((row) => row.number)).toEqual([
        'PAY-900003',
        'PAY-900002',
      ]);
      expect(page.total).toBe(5);
    });
  });

  describe('Daily Transfers', () => {
    it('reads the transfers with their PAY- number, sender and reference', async () => {
      const report = await body<PaymentsBody & { totalKobo: number }>(
        StaffRole.CASHIER,
        `transfers?from=${D1}&to=${D2}`,
      );

      expect(report.data).toEqual([
        expect.objectContaining({
          number: 'PAY-900002',
          orderNumber: 'CNCR-900001',
          method: PaymentMethod.TRANSFER,
          sender: 'Ada Okafor',
          reference: 'TRF-0001',
          amountKobo: 570_675,
          businessDate: D1,
          at: '2026-03-10T22:30:00.000Z',
        }),
      ]);
      expect(report).toMatchObject({ total: 1, totalKobo: 570_675 });
      expect(
        (
          await body<PaymentsBody>(
            StaffRole.CASHIER,
            `transfers?from=${D2}&to=${D2}`,
          )
        ).data,
      ).toEqual([]);
    });
  });

  describe('Stock Movements', () => {
    it('reads the movements made in each Jos day, newest first', async () => {
      type Movements = {
        data: {
          stockItemId: string;
          qty: number;
          at: string;
          staffName: string | null;
        }[];
        total: number;
      };
      const both = await body<Movements>(
        StaffRole.MANAGER,
        `stock-movements?from=${D1}&to=${D2}`,
      );
      const first = await body<Movements>(
        StaffRole.MANAGER,
        `stock-movements?from=${D1}&to=${D1}`,
      );
      const second = await body<Movements>(
        StaffRole.MANAGER,
        `stock-movements?from=${D2}&to=${D2}`,
      );

      expect(both.data.map((row) => [row.qty, row.at])).toEqual([
        [-2, '2026-03-10T23:01:00.000Z'],
        [5, '2026-03-10T22:59:00.000Z'],
      ]);
      expect(first.data.map((row) => row.qty)).toEqual([5]);
      expect(second.data.map((row) => row.qty)).toEqual([-2]);
      expect(second.total).toBe(1);
    });
  });

  describe('Waste', () => {
    it('reads the waste logged in each Jos day, oldest first, approved or not', async () => {
      type WasteBody = {
        data: {
          number: string;
          status: WasteStatus;
          businessDate: string;
          valueKobo: number;
        }[];
        total: number;
      };
      const both = await body<WasteBody>(
        StaffRole.MANAGER,
        `waste?from=${D1}&to=${D2}`,
      );

      expect(
        both.data.map((row) => [
          row.number,
          row.status,
          row.businessDate,
          row.valueKobo,
        ]),
      ).toEqual([
        ['W-900001', WasteStatus.APPROVED, D1, 300_000],
        ['W-900002', WasteStatus.PENDING, D2, 300_000],
      ]);
      expect(
        (
          await body<WasteBody>(StaffRole.MANAGER, `waste?from=${D2}&to=${D2}`)
        ).data.map((row) => row.number),
      ).toEqual(['W-900002']);
    });
  });

  describe('Maintenance History', () => {
    it('reads the repairs reported in the range, with their cost and status', async () => {
      type Repairs = {
        data: {
          number: string;
          assetName: string;
          vendorName: string;
          reportedOn: string;
          resolvedOn: string | null;
          status: MaintenanceStatus;
          costKobo: number;
        }[];
        total: number;
      };
      const both = await body<Repairs>(
        StaffRole.MANAGER,
        `maintenance?from=${D1}&to=${D2}`,
      );

      expect(
        both.data.map((row) => [
          row.number,
          row.assetName,
          row.vendorName,
          row.reportedOn,
          row.resolvedOn,
          row.status,
          row.costKobo,
        ]),
      ).toEqual([
        [
          'MT-900001',
          'Walk-in chiller',
          'Jos Grains',
          D1,
          null,
          MaintenanceStatus.PENDING,
          250_000,
        ],
        [
          'MT-900002',
          'Walk-in chiller',
          'Jos Grains',
          D2,
          D2,
          MaintenanceStatus.FIXED,
          100_000,
        ],
      ]);
      expect(
        (
          await body<Repairs>(
            StaffRole.MANAGER,
            `maintenance?from=${D1}&to=${D1}`,
          )
        ).total,
      ).toBe(1);
    });
  });

  describe('Vendor Spend', () => {
    type Spend = {
      data: {
        vendorId: string;
        vendorName: string;
        purchasesKobo: number;
        repairsKobo: number;
        totalKobo: number;
      }[];
      total: number;
      purchasesKobo: number;
      repairsKobo: number;
      totalKobo: number;
    };

    it('sums received purchases by line vendor and repair costs, every vendor listed', async () => {
      const both = await body<Spend>(
        StaffRole.MANAGER,
        `vendor-spend?from=${D1}&to=${D2}`,
      );

      expect(both.data).toEqual([
        {
          vendorId: ids.v1,
          vendorName: 'Jos Grains',
          purchasesKobo: 600_000,
          repairsKobo: 350_000,
          totalKobo: 950_000,
        },
        {
          vendorId: ids.v2,
          vendorName: 'Plateau Cooling',
          purchasesKobo: 350_000,
          repairsKobo: 0,
          totalKobo: 350_000,
        },
      ]);
      expect(both).toMatchObject({
        total: 2,
        purchasesKobo: 950_000,
        repairsKobo: 350_000,
        totalKobo: 1_300_000,
      });
    });

    it('dates a requisition raised at 00:30 in Jos on that day', async () => {
      const first = await body<Spend>(
        StaffRole.MANAGER,
        `vendor-spend?from=${D1}&to=${D1}`,
      );
      const second = await body<Spend>(
        StaffRole.MANAGER,
        `vendor-spend?from=${D2}&to=${D2}`,
      );

      expect(
        first.data.map((row) => [row.purchasesKobo, row.repairsKobo]),
      ).toEqual([
        [600_000, 250_000],
        [150_000, 0],
      ]);
      expect(
        second.data.map((row) => [row.purchasesKobo, row.repairsKobo]),
      ).toEqual([
        [0, 100_000],
        [200_000, 0],
      ]);
    });
  });

  describe('who may read which report', () => {
    const managersOnly = [
      'sales',
      'kitchen-crosscheck',
      'stock-movements',
      'waste',
      'maintenance',
      'vendor-spend',
    ];
    const cashiers = ['payments', 'cash', 'transfers'];

    it('lets the Owner and Managers read all nine', async () => {
      for (const role of [StaffRole.OWNER, StaffRole.MANAGER]) {
        for (const path of [...managersOnly, ...cashiers]) {
          await get(role, `${path}?from=${D1}&to=${D2}`).expect(200);
        }
      }
    });

    it('lets the Cashier read Payments Received, Cash Reconciliation and Daily Transfers only', async () => {
      for (const path of cashiers) {
        await get(StaffRole.CASHIER, `${path}?from=${D1}&to=${D2}`).expect(200);
      }

      for (const path of managersOnly) {
        const refused = await get(
          StaffRole.CASHIER,
          `${path}?from=${D1}&to=${D2}`,
        ).expect(403);

        expect((refused.body as { message: unknown }).message).toBe(
          ROLE_REFUSED_MESSAGE,
        );
      }
    });

    it('refuses every report to every other role', async () => {
      for (const role of [
        StaffRole.WAITER,
        StaffRole.BARTENDER,
        StaffRole.KITCHEN,
        StaffRole.STOREKEEPER,
        StaffRole.RECEPTION,
      ]) {
        for (const path of [...managersOnly, ...cashiers]) {
          await get(role, `${path}?from=${D1}&to=${D2}`).expect(403);
        }
      }
    });

    it('refuses a reader with no token', async () => {
      await request(server())
        .get(`/api/v1/staff/reports/sales?from=${D1}&to=${D2}`)
        .expect(401);
    });
  });
});
