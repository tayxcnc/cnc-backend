import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  OrderChannel,
  OrderStatus,
  PaymentMethod,
  PurchaseStatus,
  ReservationSource,
  ReservationStatus,
  StaffRole,
  StockKind,
  StockLocation,
  StockRequestStatus,
  TableKind,
  TableSessionStatus,
  TaskStatus,
  TaskType,
  WasteReason,
  WasteStatus,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import type { OverviewResponse } from '../src/overview/dto/overview.response';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import {
  OVERVIEW_PRESETS,
  OVERVIEW_WIDGETS,
} from '../src/shell/overview-preferences';
import { createTestApp } from './create-test-app';
import { fakeDateOnly } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * The overview (card C8-1): every widget's exact figures for a manager,
 * the staff overview of every other role, the Sales Trend's interval at
 * 1, 62 and 63 days, a Lagos midnight, and bad ranges.
 *
 * On a database of its own with the real seeds, and a fixed clock: the
 * overview sums the whole range, and its "now" figures (open bills,
 * tables, today's bookings, stock, tasks, the crosscheck over every date)
 * cover the whole database, so another suite's row would move them. The
 * seeded tables are retired and the seeded stock items' minimums set to
 * zero, so only this suite's own tables and items count. Records are
 * written directly at chosen instants, as the reports suite writes them.
 *
 * Now is 12:00 in Jos on Wednesday 21 October 2026 (T). 23:30Z on 20
 * October is 00:30 in Jos on T; 22:30Z on 20 October is 23:30 in Jos on
 * the 20th.
 */
describe('Overview (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  const T = '2026-10-21';
  const NOW = Date.parse('2026-10-21T11:00:00.000Z');
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const at = (iso: string) => new Date(iso);

  const token: Partial<Record<StaffRole, string>> = {};
  const staffId: Partial<Record<StaffRole, string>> = {};
  const ids: Record<string, string> = {};
  const dish: Record<string, string> = {};
  const venue: Record<string, { id: string }> = {};
  let menuIndex = 0;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    await seedData(prisma);

    fakeDateOnly(NOW);

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
      const account = await createStaffAccount(prisma, role, {
        name: `Overview ${role.toLowerCase()}`,
      });

      staffId[role] = account.id;
      token[role] = await accessTokenFor(tokens, account.id);
    }

    await seedRecords();
  }, 180_000);

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  /** The next seeded menu item of a department. */
  async function nextDish(department: Department): Promise<string> {
    const item = await prisma.menuItem.findFirstOrThrow({
      where: { department },
      orderBy: { slug: 'asc' },
      skip: menuIndex++,
      select: { id: true },
    });

    return item.id;
  }

  async function bill(input: {
    number: string;
    department: Department;
    channel?: OrderChannel;
    openedOn: string;
    createdAt: string;
    status: OrderStatus;
    settledAt?: string;
    serviceBps?: number;
    label?: string;
    lines: {
      menuItemId: string;
      name: string;
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
        label: input.label ?? 'Overview test',
        businessDate: day(input.openedOn),
        createdAt: at(input.createdAt),
        status: input.status,
        settledAt: input.settledAt ? at(input.settledAt) : null,
        vatBps: 750,
        serviceBps: input.serviceBps ?? 0,
        openedById:
          input.channel === OrderChannel.WEB
            ? null
            : staffId[StaffRole.CASHIER],
      },
    });

    for (const [index, line] of input.lines.entries()) {
      await prisma.orderLine.create({
        data: {
          orderId: order.id,
          ...line,
          createdAt: new Date(at(input.createdAt).getTime() + index * 1000),
        },
      });
    }

    return order.id;
  }

  let paymentNo = 0;

  async function pay(input: {
    orderId: string;
    method: PaymentMethod;
    amountKobo: number;
    on: string;
    at: string;
    part?: boolean;
    reversed?: boolean;
  }): Promise<void> {
    paymentNo += 1;
    await prisma.payment.create({
      data: {
        number: `PAY-91${String(paymentNo).padStart(4, '0')}`,
        orderId: input.orderId,
        method: input.method,
        amountKobo: input.amountKobo,
        businessDate: day(input.on),
        createdAt: at(input.at),
        part: input.part ?? false,
        reversed: input.reversed ?? false,
        reversedAt: input.reversed ? at(input.at) : null,
        staffId: staffId[StaffRole.CASHIER],
      },
    });
  }

  const food = (qty: number, name = 'Food') => ({
    menuItemId: dish.food,
    name,
    department: Department.RESTAURANT,
    qty,
    unitPriceKobo: 500_000,
  });
  const drink = (qty: number) => ({
    menuItemId: dish.drink,
    name: 'Drink',
    department: Department.BAR,
    qty,
    unitPriceKobo: 200_000,
  });

  async function seedRecords(): Promise<void> {
    dish.food = await nextDish(Department.RESTAURANT);
    dish.b = await nextDish(Department.RESTAURANT);
    dish.c = await nextDish(Department.RESTAURANT);
    dish.d = await nextDish(Department.RESTAURANT);
    dish.e = await nextDish(Department.RESTAURANT);
    dish.drink = await nextDish(Department.BAR);

    await seedBills();
    await seedFloor();
    await seedAttention();
    await seedStock();
    await seedTasks();
  }

  /**
   * Settled bills (VAT 7.5%, no service unless stated):
   * - S4 Restaurant, created 20 Oct 20:00Z, settled 00:30 Jos on T, 1 food:
   *   ₦5,000 + ₦375 = ₦5,375. Paid ₦1,000 cash on the 20th (part) and
   *   ₦4,375 by transfer on T.
   * - S8 Restaurant, settled 07:00 Jos on T, dishes B to E at ₦1,000 each
   *   (lines named "Dish D", "Dish B", "Dish E", "Dish C"): ₦4,000 + ₦300
   *   = ₦4,300, paid cash.
   * - S1 Restaurant, settled 08:30 Jos on T, 2 food: ₦10,000 + ₦750 =
   *   ₦10,750. Paid ₦5,000 cash (part), ₦5,750 transfer; a reversed
   *   ₦9,999.99 cash payment does not count.
   * - S2 Bar, settled 09:15 Jos on T, 3 drinks: ₦6,000 + ₦450 = ₦6,450,
   *   card.
   * - S3 a web order, settled 10:05 Jos on T: 1 food and 2 drinks, ₦9,000 +
   *   ₦675 = ₦9,675; the Bar's share is its ₦4,000 + ₦300 = ₦4,300, the
   *   Restaurant's the ₦5,375 left. Paid ₦14,675 online, the ₦5,000
   *   delivery fee inside the payment and outside the bill.
   * - S5 Restaurant, settled 23:30 Jos on 20 Oct, 1 food, ₦5,375 cash.
   * - S6 Bar, settled 12:00 Jos on 5 Oct, 1 drink, ₦2,150 card.
   * - S7 Restaurant, settled 12:00 Jos on 15 Sept, 1 food, ₦5,375 cash.
   *
   * Today: 5 bills, ₦36,550; Restaurant ₦25,800, Bar ₦10,750.
   */
  async function seedBills(): Promise<void> {
    ids.s4 = await bill({
      number: 'CNCR-910004',
      department: Department.RESTAURANT,
      openedOn: '2026-10-20',
      createdAt: '2026-10-20T20:00:00.000Z',
      status: OrderStatus.SETTLED,
      settledAt: '2026-10-20T23:30:00.000Z',
      lines: [food(1, 'Former name')],
    });
    await pay({
      orderId: ids.s4,
      method: PaymentMethod.CASH,
      amountKobo: 100_000,
      on: '2026-10-20',
      at: '2026-10-20T20:30:00.000Z',
      part: true,
    });
    await pay({
      orderId: ids.s4,
      method: PaymentMethod.TRANSFER,
      amountKobo: 437_500,
      on: T,
      at: '2026-10-20T23:30:00.000Z',
    });

    ids.s8 = await bill({
      number: 'CNCR-910008',
      department: Department.RESTAURANT,
      openedOn: T,
      createdAt: '2026-10-21T05:30:00.000Z',
      status: OrderStatus.SETTLED,
      settledAt: '2026-10-21T06:00:00.000Z',
      lines: [
        { ...food(1, 'Dish D'), menuItemId: dish.d, unitPriceKobo: 100_000 },
        { ...food(1, 'Dish B'), menuItemId: dish.b, unitPriceKobo: 100_000 },
        { ...food(1, 'Dish E'), menuItemId: dish.e, unitPriceKobo: 100_000 },
        { ...food(1, 'Dish C'), menuItemId: dish.c, unitPriceKobo: 100_000 },
      ],
    });
    await pay({
      orderId: ids.s8,
      method: PaymentMethod.CASH,
      amountKobo: 430_000,
      on: T,
      at: '2026-10-21T06:00:00.000Z',
    });

    ids.s1 = await bill({
      number: 'CNCR-910001',
      department: Department.RESTAURANT,
      openedOn: T,
      createdAt: '2026-10-21T06:30:00.000Z',
      status: OrderStatus.SETTLED,
      settledAt: '2026-10-21T07:30:00.000Z',
      lines: [food(2)],
    });
    await pay({
      orderId: ids.s1,
      method: PaymentMethod.CASH,
      amountKobo: 500_000,
      on: T,
      at: '2026-10-21T07:00:00.000Z',
      part: true,
    });
    await pay({
      orderId: ids.s1,
      method: PaymentMethod.CASH,
      amountKobo: 999_999,
      on: T,
      at: '2026-10-21T07:20:00.000Z',
      reversed: true,
    });
    await pay({
      orderId: ids.s1,
      method: PaymentMethod.TRANSFER,
      amountKobo: 575_000,
      on: T,
      at: '2026-10-21T07:30:00.000Z',
    });

    ids.s2 = await bill({
      number: 'CNCB-910002',
      department: Department.BAR,
      openedOn: T,
      createdAt: '2026-10-21T07:45:00.000Z',
      status: OrderStatus.SETTLED,
      settledAt: '2026-10-21T08:15:00.000Z',
      lines: [drink(3)],
    });
    await pay({
      orderId: ids.s2,
      method: PaymentMethod.CARD,
      amountKobo: 645_000,
      on: T,
      at: '2026-10-21T08:15:00.000Z',
    });

    ids.s3 = await bill({
      number: 'CNCR-910003',
      department: Department.RESTAURANT,
      channel: OrderChannel.WEB,
      openedOn: T,
      createdAt: '2026-10-21T09:00:00.000Z',
      status: OrderStatus.SETTLED,
      settledAt: '2026-10-21T09:05:00.000Z',
      lines: [food(1), drink(2)],
    });
    await pay({
      orderId: ids.s3,
      method: PaymentMethod.ONLINE,
      amountKobo: 1_467_500,
      on: T,
      at: '2026-10-21T09:05:00.000Z',
    });

    ids.s5 = await bill({
      number: 'CNCR-910005',
      department: Department.RESTAURANT,
      openedOn: '2026-10-20',
      createdAt: '2026-10-20T19:00:00.000Z',
      status: OrderStatus.SETTLED,
      settledAt: '2026-10-20T22:30:00.000Z',
      lines: [food(1)],
    });
    await pay({
      orderId: ids.s5,
      method: PaymentMethod.CASH,
      amountKobo: 537_500,
      on: '2026-10-20',
      at: '2026-10-20T22:30:00.000Z',
    });

    ids.s6 = await bill({
      number: 'CNCB-910006',
      department: Department.BAR,
      openedOn: '2026-10-05',
      createdAt: '2026-10-05T10:00:00.000Z',
      status: OrderStatus.SETTLED,
      settledAt: '2026-10-05T11:00:00.000Z',
      lines: [drink(1)],
    });
    await pay({
      orderId: ids.s6,
      method: PaymentMethod.CARD,
      amountKobo: 215_000,
      on: '2026-10-05',
      at: '2026-10-05T11:00:00.000Z',
    });

    ids.s7 = await bill({
      number: 'CNCR-910007',
      department: Department.RESTAURANT,
      openedOn: '2026-09-15',
      createdAt: '2026-09-15T10:00:00.000Z',
      status: OrderStatus.SETTLED,
      settledAt: '2026-09-15T11:00:00.000Z',
      lines: [food(1)],
    });
    await pay({
      orderId: ids.s7,
      method: PaymentMethod.CASH,
      amountKobo: 537_500,
      on: '2026-09-15',
      at: '2026-09-15T11:00:00.000Z',
    });

    // Open bills, newest first: G (₦5,000 + 10% service ₦500 + VAT ₦412.50
    // = ₦5,912.50; a reversed payment does not count), F (Bar, at Payment,
    // ₦4,300), E (₦5,375 less ₦1,000 part-paid = ₦4,375), then three empty
    // bills owing nothing. Six open, ₦14,587.50 owed. A cancelled bill is
    // neither.
    ids.e = await bill({
      number: 'CNCR-910020',
      department: Department.RESTAURANT,
      openedOn: '2026-10-19',
      createdAt: '2026-10-19T10:00:00.000Z',
      status: OrderStatus.OPEN,
      label: 'D-OV1',
      lines: [food(1)],
    });
    await pay({
      orderId: ids.e,
      method: PaymentMethod.CASH,
      amountKobo: 100_000,
      on: T,
      at: '2026-10-21T08:00:00.000Z',
      part: true,
    });
    ids.f = await bill({
      number: 'CNCB-910021',
      department: Department.BAR,
      openedOn: T,
      createdAt: '2026-10-21T09:30:00.000Z',
      status: OrderStatus.PAYMENT,
      label: 'Bar counter',
      lines: [drink(2)],
    });
    ids.g = await bill({
      number: 'CNCR-910022',
      department: Department.RESTAURANT,
      openedOn: T,
      createdAt: '2026-10-21T10:30:00.000Z',
      status: OrderStatus.OPEN,
      serviceBps: 1000,
      label: 'L-OV1',
      lines: [food(1)],
    });
    await pay({
      orderId: ids.g,
      method: PaymentMethod.CASH,
      amountKobo: 50_000,
      on: T,
      at: '2026-10-21T10:40:00.000Z',
      reversed: true,
    });

    for (const [index, opened] of [
      '2026-10-18',
      '2026-10-17',
      '2026-10-16',
    ].entries()) {
      ids[`empty${index}`] = await bill({
        number: `CNCR-91003${index}`,
        department: Department.RESTAURANT,
        openedOn: opened,
        createdAt: `${opened}T10:00:00.000Z`,
        status: OrderStatus.OPEN,
        lines: [],
      });
    }

    ids.cancelled = await bill({
      number: 'CNCR-910040',
      department: Department.RESTAURANT,
      openedOn: T,
      createdAt: '2026-10-21T10:45:00.000Z',
      status: OrderStatus.CANCELLED,
      lines: [food(3)],
    });
  }

  /**
   * The floor: the seeded tables retired; three Diner tables (OV1 seated,
   * OV2 locked, OV3 booked), two Lounge tables (OV1 holds a Checked In
   * booking, its session ended; OV2 free with only a cancelled booking
   * today and one tomorrow), and a retired Diner table seated, which
   * counts nowhere. Today's Confirmed bookings: Diner OV1 at 13:00 and
   * Diner OV3 at 19:30.
   */
  async function seedFloor(): Promise<void> {
    await prisma.diningTable.updateMany({ data: { active: false } });

    for (const slug of ['dining', 'lounge']) {
      venue[slug] = await prisma.venue.findUniqueOrThrow({
        where: { slug },
        select: { id: true },
      });
    }

    const table = async (slug: string, code: string, active = true) =>
      (
        await prisma.diningTable.create({
          data: {
            venueId: venue[slug].id,
            code,
            name: `${slug === 'dining' ? 'Diner' : 'Lounge'} ${code}`,
            kind: TableKind.DINING,
            capacity: 4,
            active,
          },
        })
      ).id;

    ids.d1 = await table('dining', 'OV1');
    ids.d2 = await table('dining', 'OV2');
    ids.d3 = await table('dining', 'OV3');
    ids.l1 = await table('lounge', 'OV1');
    ids.l2 = await table('lounge', 'OV2');
    ids.retired = await table('dining', 'OV9', false);

    const session = (
      tableId: string,
      status: TableSessionStatus,
      endedAt: Date | null = null,
    ) =>
      prisma.tableSession.create({
        data: {
          tableId,
          status,
          guest: 'Guest',
          party: 2,
          note: status === TableSessionStatus.LOCKED ? 'Repair' : '',
          endedAt,
          closedById: endedAt ? staffId[StaffRole.RECEPTION]! : null,
          openedById: staffId[StaffRole.RECEPTION]!,
        },
      });

    await session(ids.d1, TableSessionStatus.OCCUPIED);
    await session(ids.d2, TableSessionStatus.LOCKED);
    await session(
      ids.l1,
      TableSessionStatus.OCCUPIED,
      at('2026-10-21T10:00:00.000Z'),
    );
    await session(ids.retired, TableSessionStatus.OCCUPIED);

    let reservationNo = 0;
    const book = (input: {
      tableId: string;
      date: string;
      minutes: number;
      name: string;
      party: number;
      status: ReservationStatus;
    }) => {
      reservationNo += 1;

      return prisma.reservation.create({
        data: {
          number: `CNCRES-91${reservationNo}`,
          tableId: input.tableId,
          name: input.name,
          phone: '08030000000',
          email: 'guest@example.com',
          businessDate: day(input.date),
          startMinutes: input.minutes,
          party: input.party,
          status: input.status,
          cancelledAt:
            input.status === ReservationStatus.CANCELLED
              ? at('2026-10-21T09:00:00.000Z')
              : null,
          source: ReservationSource.RECEPTION,
        },
      });
    };

    ids.r3 = (
      await book({
        tableId: ids.d3,
        date: T,
        minutes: 19 * 60 + 30,
        name: 'Guest Three',
        party: 4,
        status: ReservationStatus.CONFIRMED,
      })
    ).id;
    ids.r1 = (
      await book({
        tableId: ids.d1,
        date: T,
        minutes: 13 * 60,
        name: 'Guest One',
        party: 2,
        status: ReservationStatus.CONFIRMED,
      })
    ).id;
    await book({
      tableId: ids.l1,
      date: T,
      minutes: 12 * 60,
      name: 'Guest Seated',
      party: 3,
      status: ReservationStatus.CHECKED_IN,
    });
    await book({
      tableId: ids.l2,
      date: T,
      minutes: 18 * 60,
      name: 'Guest Cancelled',
      party: 2,
      status: ReservationStatus.CANCELLED,
    });
    await book({
      tableId: ids.l2,
      date: '2026-10-22',
      minutes: 18 * 60,
      name: 'Guest Tomorrow',
      party: 2,
      status: ReservationStatus.CONFIRMED,
    });
  }

  /**
   * Needs Attention:
   * - two requisitions awaiting approval (one approved, one archived
   *   pending: neither counts);
   * - one waste entry awaiting review (one approved);
   * - the crosscheck over every date: KOT for S1 (no entry), KOT for an
   *   old 2025 bill (no entry), and two entries no docket explains (one
   *   on T, one in 2025) are not Matched; KOT for S4 is Matched by its
   *   rule. Four.
   * - stock requests: Pending at the Bar, Partially Issued in the Kitchen
   *   (Issued and Rejected ones do not count).
   */
  async function seedAttention(): Promise<void> {
    const vendor = await prisma.vendor.create({
      data: { name: 'Overview Vendor', phone: '08030000001' },
    });
    const purchaseStatuses: [PurchaseStatus, boolean][] = [
      [PurchaseStatus.PENDING, false],
      [PurchaseStatus.PENDING, false],
      [PurchaseStatus.APPROVED, false],
      [PurchaseStatus.PENDING, true],
    ];

    for (const [index, [status, archived]] of purchaseStatuses.entries()) {
      await prisma.purchase.create({
        data: {
          number: `PR-91${index}`,
          vendorId: vendor.id,
          status,
          archived,
          createdById: staffId[StaffRole.STOREKEEPER]!,
        },
      });
    }

    const kitchenItem = await prisma.stockItem.create({
      data: {
        name: 'Overview portion',
        kind: StockKind.KITCHEN,
        unit: 'portion',
        pack: 'tray',
        factor: 10,
        minimum: 0,
      },
    });

    ids.portion = kitchenItem.id;

    for (const [index, status] of [
      WasteStatus.PENDING,
      WasteStatus.APPROVED,
    ].entries()) {
      await prisma.wasteEntry.create({
        data: {
          number: `W-91${index}`,
          location: StockLocation.KITCHEN,
          stockItemId: kitchenItem.id,
          qty: 1,
          reason: WasteReason.SPOILED,
          status,
          valueKobo: 0,
          createdById: staffId[StaffRole.KITCHEN]!,
        },
      });
    }

    ids.old = await bill({
      number: 'CNCR-910050',
      department: Department.RESTAURANT,
      openedOn: '2025-01-10',
      createdAt: '2025-01-10T10:00:00.000Z',
      status: OrderStatus.CANCELLED,
      lines: [],
    });

    const docket = (
      orderId: string,
      ref: string,
      on: string,
      qty: number,
      createdAt: string,
    ) =>
      prisma.docket.create({
        data: {
          ref,
          orderId,
          revision: 1,
          businessDate: day(on),
          createdAt: at(createdAt),
          items: [
            {
              menuItemId: dish.food,
              name: 'Food',
              option: '',
              qty,
              unitPriceKobo: 500_000,
            },
          ],
          channel: OrderChannel.POS,
          staffId: staffId[StaffRole.CASHIER],
        },
      });
    const entry = (
      orderId: string,
      ref: string,
      on: string,
      qty: number,
      createdAt: string,
    ) =>
      prisma.kitchenEntry.create({
        data: {
          docketRef: ref,
          orderId,
          revision: 1,
          businessDate: day(on),
          createdAt: at(createdAt),
          lines: [{ stockItemId: kitchenItem.id, qty }],
          staffId: staffId[StaffRole.KITCHEN]!,
        },
      });

    await prisma.kitchenMapping.create({
      data: { menuItemId: dish.food, stockItemId: kitchenItem.id, qty: 1 },
    });
    const OLD = '2025-01-10';
    const S4_DOCKET_AT = '2026-10-20T20:05:00Z';

    await docket(ids.old, 'KOT-CNCR-910050', OLD, 1, `${OLD}T10:05:00Z`);
    await docket(ids.s4, 'KOT-CNCR-910004', '2026-10-20', 1, S4_DOCKET_AT);
    await entry(ids.s4, 'KOT-CNCR-910004', T, 1, `${T}T05:00:00Z`);
    await docket(ids.s1, 'KOT-CNCR-910001', T, 2, `${T}T06:35:00Z`);
    await entry(ids.old, 'KOT-GHOST-2025', OLD, 1, `${OLD}T11:00:00Z`);
    await entry(ids.s1, 'KOT-GHOST-TODAY', T, 1, `${T}T09:00:00Z`);

    const requests: [StockLocation, StockRequestStatus][] = [
      [StockLocation.BAR, StockRequestStatus.PENDING],
      [StockLocation.KITCHEN, StockRequestStatus.PARTIALLY_ISSUED],
      [StockLocation.KITCHEN, StockRequestStatus.ISSUED],
      [StockLocation.BAR, StockRequestStatus.REJECTED],
    ];

    for (const [index, [location, status]] of requests.entries()) {
      await prisma.stockRequest.create({
        data: {
          number: `SR-91${index}`,
          location,
          stockItemId: kitchenItem.id,
          qtyPacks: 2,
          issuedPacks: {
            [StockRequestStatus.PENDING]: 0,
            [StockRequestStatus.PARTIALLY_ISSUED]: 1,
            [StockRequestStatus.ISSUED]: 2,
            [StockRequestStatus.REJECTED]: 0,
          }[status],
          rejectReason:
            status === StockRequestStatus.REJECTED ? 'Not needed' : null,
          status,
          createdById: staffId[StaffRole.KITCHEN]!,
        },
      });
    }
  }

  /**
   * Low Stock: the seeded items' minimums set to zero, then eleven items
   * of the suite's own, added in this order:
   * K1 (Kitchen 3 of 10, low), K2 (5 of 5, not low), K3 (no balance of 4,
   * low at 0), K4 (Kitchen 1 of 2, low, though 50 in the Store), B1 (Bar
   * −2 of 12, low), B2 (12 of 12, not low), B3 (Bar 1 of 6, low), K5 to K9
   * (no balance of 3, low at 0). Ten are low; lowest first, ties in the
   * order added: B1, K3, K5, K6, K7, K8, K9, K4, then B3 and K1.
   */
  async function seedStock(): Promise<void> {
    await prisma.stockItem.updateMany({
      where: { id: { not: ids.portion } },
      data: { minimum: 0 },
    });

    type Item = {
      key: string;
      kind: StockKind;
      minimum: number;
      balances: [StockLocation, number][];
    };
    const kitchen = (key: string, minimum: number, qty?: number): Item => ({
      key,
      kind: StockKind.KITCHEN,
      minimum,
      balances: qty === undefined ? [] : [[StockLocation.KITCHEN, qty]],
    });
    const bar = (key: string, minimum: number, qty: number): Item => ({
      key,
      kind: StockKind.BAR,
      minimum,
      balances: [[StockLocation.BAR, qty]],
    });
    const k4 = kitchen('K4', 2, 1);

    k4.balances.push([StockLocation.STORE, 50]);

    const items: Item[] = [
      kitchen('K1', 10, 3),
      kitchen('K2', 5, 5),
      kitchen('K3', 4),
      k4,
      bar('B1', 12, -2),
      bar('B2', 12, 12),
      bar('B3', 6, 1),
      ...['K5', 'K6', 'K7', 'K8', 'K9'].map((key) => kitchen(key, 3)),
    ];

    // A Bar stock item is always a Bar dish's pair (a CHECK), so the Bar
    // items are seeded pairs, renamed and placed in the order.
    const barPairs = await prisma.stockItem.findMany({
      where: { kind: StockKind.BAR },
      orderBy: { id: 'asc' },
      take: 3,
      select: { id: true },
    });

    for (const [index, item] of items.entries()) {
      const data = {
        name: `Overview ${item.key}`,
        unit: item.kind === StockKind.BAR ? 'bottle' : 'portion',
        minimum: item.minimum,
        createdAt: new Date(NOW + index * 1000),
      };
      const row =
        item.kind === StockKind.BAR
          ? await prisma.stockItem.update({
              where: { id: barPairs.shift()!.id },
              data,
            })
          : await prisma.stockItem.create({
              data: { ...data, kind: item.kind, pack: 'case', factor: 12 },
            });

      ids[item.key] = row.id;

      for (const [location, qty] of item.balances) {
        await prisma.stockBalance.create({
          data: { stockItemId: row.id, location, qty },
        });
      }
    }
  }

  /**
   * Tasks: seven not Done (four for the Storekeeper, two for Reception,
   * one for Kitchen), oldest first T1…T7, and one Done.
   */
  async function seedTasks(): Promise<void> {
    const plan: [StaffRole, TaskStatus][] = [
      [StaffRole.STOREKEEPER, TaskStatus.OPEN],
      [StaffRole.RECEPTION, TaskStatus.IN_PROGRESS],
      [StaffRole.STOREKEEPER, TaskStatus.OPEN],
      [StaffRole.KITCHEN, TaskStatus.IN_PROGRESS],
      [StaffRole.STOREKEEPER, TaskStatus.DONE],
      [StaffRole.STOREKEEPER, TaskStatus.OPEN],
      [StaffRole.RECEPTION, TaskStatus.OPEN],
      [StaffRole.STOREKEEPER, TaskStatus.OPEN],
    ];
    let shown = 0;

    for (const [index, [role, status]] of plan.entries()) {
      const title = status === TaskStatus.DONE ? 'Done task' : `T${++shown}`;
      const task = await prisma.task.create({
        data: {
          number: `T-91${index}`,
          title,
          type: TaskType.GENERAL,
          assignedToId: staffId[role]!,
          raisedById: staffId[StaffRole.MANAGER]!,
          status,
          createdAt: at(`2026-10-0${index + 1}T10:00:00.000Z`),
        },
      });

      ids[title] = task.id;
    }
  }

  // ------------------------------------------------------------ helpers

  const read = (role: StaffRole, query = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/staff/overview${query}`)
      .set('Authorization', `Bearer ${token[role]}`);

  /** The overview a role reads (200). */
  const overview = async (role: StaffRole, query = '') =>
    (await read(role, query).expect(200)).body as OverviewResponse;

  /** A trend that is there. */
  const trendOf = (body: OverviewResponse) => body.trend!;

  async function showAll(role: StaffRole): Promise<void> {
    await request(app.getHttpServer())
      .put('/api/v1/staff/me/preferences/overview')
      .set('Authorization', `Bearer ${token[role]}`)
      .send({
        version: 1,
        widgets: OVERVIEW_WIDGETS.map((id) => ({
          id,
          visible: true,
          wide: false,
        })),
        period: 'Today',
        from: T,
        to: T,
      })
      .expect(200);
  }

  /** The hourly trend of T: 24 points, these hours non-zero. */
  function hours(amounts: Record<string, number>) {
    return Array.from({ length: 24 }, (_, hour) => {
      const key = String(hour).padStart(2, '0');

      return { key, name: `${key}:00`, amountKobo: amounts[key] ?? 0 };
    });
  }

  const venues = (counts: {
    dining: [number, number, number, number];
    lounge: [number, number, number, number];
  }) =>
    (['dining', 'lounge'] as const).map((slug) => ({
      venueId: venue[slug].id,
      slug,
      name: slug === 'dining' ? 'Diner' : 'Lounge',
      available: counts[slug][0],
      occupied: counts[slug][1],
      reserved: counts[slug][2],
      locked: counts[slug][3],
    }));

  const SERVICE = () => venues({ dining: [0, 1, 1, 1], lounge: [1, 0, 1, 0] });
  const OCCUPANCY = { occupied: 1, tables: 5 };
  const ARRIVALS = () => [
    {
      reservationId: ids.r1,
      number: 'CNCRES-912',
      time: '13:00',
      name: 'Guest One',
      tableName: 'Diner OV1',
      party: 2,
      status: ReservationStatus.CONFIRMED,
    },
    {
      reservationId: ids.r3,
      number: 'CNCRES-911',
      time: '19:30',
      name: 'Guest Three',
      tableName: 'Diner OV3',
      party: 4,
      status: ReservationStatus.CONFIRMED,
    },
  ];
  const OPEN_ORDERS = () => [
    {
      orderId: ids.g,
      number: 'CNCR-910022',
      businessDate: T,
      department: Department.RESTAURANT,
      label: 'L-OV1',
      status: OrderStatus.OPEN,
      balanceKobo: 591_250,
    },
    {
      orderId: ids.f,
      number: 'CNCB-910021',
      businessDate: T,
      department: Department.BAR,
      label: 'Bar counter',
      status: OrderStatus.PAYMENT,
      balanceKobo: 430_000,
    },
    {
      orderId: ids.e,
      number: 'CNCR-910020',
      businessDate: '2026-10-19',
      department: Department.RESTAURANT,
      label: 'D-OV1',
      status: OrderStatus.OPEN,
      balanceKobo: 437_500,
    },
    {
      orderId: ids.empty0,
      number: 'CNCR-910030',
      businessDate: '2026-10-18',
      department: Department.RESTAURANT,
      label: 'Overview test',
      status: OrderStatus.OPEN,
      balanceKobo: 0,
    },
    {
      orderId: ids.empty1,
      number: 'CNCR-910031',
      businessDate: '2026-10-17',
      department: Department.RESTAURANT,
      label: 'Overview test',
      status: OrderStatus.OPEN,
      balanceKobo: 0,
    },
  ];
  const attention = (counts: Partial<Record<string, number>>) =>
    (
      [
        ['PURCHASES', 'Purchase Requisitions', 'approvals'],
        ['WASTE', 'Waste Awaiting Review', 'approvals'],
        ['CROSSCHECK', 'Kitchen Crosscheck', 'reports'],
        ['STOCK_REQUESTS', 'Open Stock Requests', 'inventory'],
        ['TASKS', 'Tasks in Progress', 'tasks'],
      ] as const
    )
      .filter(([key]) => counts[key] !== undefined)
      .map(([key, label, page]) => ({ key, label, page, count: counts[key] }));

  // -------------------------------------------------------------- tests

  it('gives a manager every widget of their layout, with exact figures', async () => {
    await showAll(StaffRole.MANAGER);

    const body = await overview(StaffRole.MANAGER, `?from=${T}&to=${T}`);

    expect(body).toEqual({
      from: T,
      to: T,
      scope: 'FULL',
      widgets: [...OVERVIEW_WIDGETS],
      sales: { totalKobo: 3_655_000, orders: 5 },
      kitchenEntries: null,
      outstanding: { totalKobo: 1_458_750, orders: 6 },
      occupancy: OCCUPANCY,
      arrivals: 2,
      trend: {
        interval: 'HOUR',
        points: hours({
          '00': 537_500,
          '07': 430_000,
          '08': 1_075_000,
          '09': 645_000,
          '10': 967_500,
        }),
      },
      departments: [
        { department: Department.RESTAURANT, amountKobo: 2_580_000 },
        { department: Department.BAR, amountKobo: 1_075_000 },
      ],
      // Transfer first: its first payment (S4's, 23:30Z on the 20th) was
      // taken before any other counted one. S4's ₦1,000 part payment on
      // the 20th is outside the range; the reversed one never counts; the
      // web payment carries its ₦5,000 fee; E's part payment is on a bill
      // not settled.
      payments: [
        { method: PaymentMethod.TRANSFER, amountKobo: 1_012_500 },
        { method: PaymentMethod.CASH, amountKobo: 930_000 },
        { method: PaymentMethod.CARD, amountKobo: 645_000 },
        { method: PaymentMethod.ONLINE, amountKobo: 1_467_500 },
      ],
      bestsellers: [
        { menuItemId: dish.drink, name: 'Drink', qty: 5 },
        { menuItemId: dish.food, name: 'Former name', qty: 4 },
        { menuItemId: dish.b, name: 'Dish B', qty: 1 },
        { menuItemId: dish.c, name: 'Dish C', qty: 1 },
        { menuItemId: dish.d, name: 'Dish D', qty: 1 },
      ],
      service: SERVICE(),
      attention: attention({
        PURCHASES: 2,
        WASTE: 1,
        CROSSCHECK: 4,
        STOCK_REQUESTS: 2,
        TASKS: 7,
      }),
      orders: OPEN_ORDERS(),
      nextArrivals: ARRIVALS(),
      stock: {
        data: [
          ['B1', StockLocation.BAR, -2, 'bottle', 12],
          ['K3', StockLocation.KITCHEN, 0, 'portion', 4],
          ['K5', StockLocation.KITCHEN, 0, 'portion', 3],
          ['K6', StockLocation.KITCHEN, 0, 'portion', 3],
          ['K7', StockLocation.KITCHEN, 0, 'portion', 3],
          ['K8', StockLocation.KITCHEN, 0, 'portion', 3],
          ['K9', StockLocation.KITCHEN, 0, 'portion', 3],
          ['K4', StockLocation.KITCHEN, 1, 'portion', 2],
        ].map(([key, location, qty, unit, minimum]) => ({
          stockItemId: ids[key as string],
          name: `Overview ${key as string}`,
          location,
          qty,
          unit,
          minimum,
        })),
        total: 10,
      },
      tasks: {
        data: (
          [
            ['T1', StaffRole.STOREKEEPER, TaskStatus.OPEN, 0],
            ['T2', StaffRole.RECEPTION, TaskStatus.IN_PROGRESS, 1],
            ['T3', StaffRole.STOREKEEPER, TaskStatus.OPEN, 2],
            ['T4', StaffRole.KITCHEN, TaskStatus.IN_PROGRESS, 3],
            ['T5', StaffRole.STOREKEEPER, TaskStatus.OPEN, 5],
            ['T6', StaffRole.RECEPTION, TaskStatus.OPEN, 6],
          ] as const
        ).map(([title, role, status, index]) => ({
          taskId: ids[title],
          number: `T-91${index}`,
          title,
          assignedToName: `Overview ${role.toLowerCase()}`,
          status,
        })),
        total: 7,
      },
    });
  });

  it('files a sale by its Lagos settlement date and counts payments dated in the range', async () => {
    const body = await overview(
      StaffRole.MANAGER,
      '?from=2026-10-20&to=2026-10-21',
    );

    // S5 (23:30 Jos on the 20th) is the 20th's; S4 (00:30 Jos on T) is T's.
    expect(body.trend).toEqual({
      interval: 'DAY',
      points: [
        { key: '2026-10-20', name: '20 Oct', amountKobo: 537_500 },
        { key: '2026-10-21', name: '21 Oct', amountKobo: 3_655_000 },
      ],
    });
    expect(body.sales).toEqual({ totalKobo: 4_192_500, orders: 6 });
    expect(body.departments).toEqual([
      { department: Department.RESTAURANT, amountKobo: 3_117_500 },
      { department: Department.BAR, amountKobo: 1_075_000 },
    ]);
    // Now S4's part payment on the 20th counts, and Cash comes first.
    expect(body.payments).toEqual([
      { method: PaymentMethod.CASH, amountKobo: 1_567_500 },
      { method: PaymentMethod.TRANSFER, amountKobo: 1_012_500 },
      { method: PaymentMethod.CARD, amountKobo: 645_000 },
      { method: PaymentMethod.ONLINE, amountKobo: 1_467_500 },
    ]);
    expect(body.bestsellers![1]).toEqual({
      menuItemId: dish.food,
      name: 'Food',
      qty: 5,
    });
    // The "now" widgets do not follow the range.
    expect(body.outstanding).toEqual({ totalKobo: 1_458_750, orders: 6 });
    expect(body.arrivals).toBe(2);
  });

  it('is hourly for one day, daily up to 62 days and monthly at 63', async () => {
    const one = trendOf(
      await overview(StaffRole.MANAGER, `?from=${T}&to=${T}`),
    );

    expect(one.interval).toBe('HOUR');
    expect(one.points).toHaveLength(24);

    const dailyBody = await overview(
      StaffRole.MANAGER,
      '?from=2026-09-01&to=2026-11-01',
    );
    const daily = trendOf(dailyBody);

    expect(daily.interval).toBe('DAY');
    expect(daily.points).toHaveLength(62);
    expect(daily.points[0].key).toBe('2026-09-01');
    expect(daily.points[61]).toEqual({
      key: '2026-11-01',
      name: '1 Nov',
      amountKobo: 0,
    });
    // September's short name is the runtime's ICU's (`Sep` or `Sept`), as
    // it is in the browser that runs the demo's same call.
    const september = new Date('2026-09-15T12:00:00Z').toLocaleDateString(
      'en-GB',
      { timeZone: 'UTC', day: 'numeric', month: 'short' },
    );

    expect(september).toMatch(/^15 Sept?$/);
    expect(daily.points.filter((point) => point.amountKobo !== 0)).toEqual([
      { key: '2026-09-15', name: september, amountKobo: 537_500 },
      { key: '2026-10-05', name: '5 Oct', amountKobo: 215_000 },
      { key: '2026-10-20', name: '20 Oct', amountKobo: 537_500 },
      { key: '2026-10-21', name: '21 Oct', amountKobo: 3_655_000 },
    ]);
    expect(dailyBody.sales).toEqual({ totalKobo: 4_945_000, orders: 8 });

    const monthlyBody = await overview(
      StaffRole.MANAGER,
      '?from=2026-09-01&to=2026-11-02',
    );
    const monthly = trendOf(monthlyBody);

    expect(monthly.interval).toBe('MONTH');
    expect(
      monthly.points.map((point) => [point.key, point.amountKobo]),
    ).toEqual([
      ['2026-09', 537_500],
      ['2026-10', 4_407_500],
      ['2026-11', 0],
    ]);
    expect(monthly.points[1].name).toBe('Oct 26');
    expect(monthly.points[2].name).toBe('Nov 26');
    expect(monthlyBody.sales).toEqual({ totalKobo: 4_945_000, orders: 8 });
  });

  it('gives the Owner with no saved layout the Service preset, and nothing else', async () => {
    const body = await overview(StaffRole.OWNER);

    expect(body.scope).toBe('FULL');
    expect(body.widgets).toEqual([...OVERVIEW_PRESETS.Service]);
    expect(body).toMatchObject({
      from: T,
      to: T,
      sales: { totalKobo: 3_655_000, orders: 5 },
      outstanding: { totalKobo: 1_458_750, orders: 6 },
      occupancy: OCCUPANCY,
      arrivals: 2,
      service: SERVICE(),
      orders: OPEN_ORDERS(),
      nextArrivals: ARRIVALS(),
      trend: null,
      departments: null,
      payments: null,
      bestsellers: null,
      stock: null,
      tasks: null,
      kitchenEntries: null,
    });
    expect(body.attention).toEqual(
      attention({
        PURCHASES: 2,
        WASTE: 1,
        CROSSCHECK: 4,
        STOCK_REQUESTS: 2,
        TASKS: 7,
      }),
    );
  });

  it('computes only what a manager’s layout shows', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/staff/me/preferences/overview')
      .set('Authorization', `Bearer ${token[StaffRole.OWNER]}`)
      .send({
        version: 1,
        widgets: [
          { id: 'stock', visible: true, wide: true },
          { id: 'payments', visible: true, wide: false },
        ],
        period: 'Custom',
        from: T,
        to: T,
      })
      .expect(200);

    const body = await overview(StaffRole.OWNER);

    expect(body.widgets).toEqual(['stock', 'payments']);
    expect(body.stock!.total).toBe(10);
    expect(body.payments).toHaveLength(4);

    for (const id of OVERVIEW_WIDGETS) {
      if (id !== 'stock' && id !== 'payments') expect(body[id]).toBeNull();
    }
  });

  describe('the staff overview', () => {
    /** What every staff role sees alike: tables and today's bookings. */
    const shared = () => ({
      scope: 'BASIC',
      widgets: [...OVERVIEW_PRESETS.Service],
      occupancy: OCCUPANCY,
      arrivals: 2,
      service: SERVICE(),
      nextArrivals: ARRIVALS(),
      trend: null,
      departments: null,
      payments: null,
      bestsellers: null,
      stock: null,
      tasks: null,
    });

    it('is today’s, whatever range a staff role asks for', async () => {
      const body = await overview(
        StaffRole.CASHIER,
        '?from=2026-09-01&to=2026-11-02',
      );

      expect(body).toEqual({
        from: T,
        to: T,
        ...shared(),
        sales: { totalKobo: 3_655_000, orders: 5 },
        kitchenEntries: null,
        outstanding: { totalKobo: 1_458_750, orders: 6 },
        orders: OPEN_ORDERS(),
        // Reports opens for the Cashier, but not the crosscheck report.
        attention: attention({ TASKS: 0 }),
      });
    });

    it('gives each role its own rows', async () => {
      const everyBill = {
        sales: { totalKobo: 3_655_000, orders: 5 },
        kitchenEntries: null,
        outstanding: { totalKobo: 1_458_750, orders: 6 },
        orders: OPEN_ORDERS(),
      };
      const expected: [StaffRole, object][] = [
        [
          StaffRole.RECEPTION,
          { ...everyBill, attention: attention({ TASKS: 2 }) },
        ],
        [StaffRole.WAITER, { ...everyBill, attention: [] }],
        [
          StaffRole.STOREKEEPER,
          {
            ...everyBill,
            attention: attention({ STOCK_REQUESTS: 2, TASKS: 4 }),
          },
        ],
        [
          StaffRole.KITCHEN,
          {
            ...everyBill,
            sales: null,
            kitchenEntries: 2,
            attention: attention({ STOCK_REQUESTS: 1, TASKS: 1 }),
          },
        ],
        // The Bartender's bills are the Bar's: S2 and S3's drinks; F.
        [
          StaffRole.BARTENDER,
          {
            sales: { totalKobo: 1_075_000, orders: 2 },
            kitchenEntries: null,
            outstanding: { totalKobo: 430_000, orders: 1 },
            orders: [OPEN_ORDERS()[1]],
            attention: attention({ STOCK_REQUESTS: 1 }),
          },
        ],
      ];

      for (const [role, figures] of expected) {
        const body = await overview(role);

        expect({ role, body }).toEqual({
          role,
          body: { from: T, to: T, ...shared(), ...figures },
        });
      }
    });
  });

  describe('bad requests', () => {
    it('refuses a bad range in the reports’ words', async () => {
      const refused = async (query: string, message: string) => {
        const response = await read(StaffRole.MANAGER, query).expect(400);
        const body = response.body as { message: string | string[] };

        // The field checks answer a list of one; the range rule a string.
        expect([body.message].flat()).toEqual([message]);
      };

      await refused(
        '?from=2026-10-21&to=2026-10-20',
        'to must not be before from.',
      );
      await refused('?from=2026-02-30', 'from must be a real calendar date.');
      await refused(
        '?from=2025-10-20&to=2026-10-21',
        'The overview covers at most 366 days at a time; 2025-10-20 to 2026-10-21 is 367.',
      );
    });

    it('takes no page, and no anonymous reader', async () => {
      await read(StaffRole.MANAGER, '?page=1').expect(400);
      await request(app.getHttpServer())
        .get('/api/v1/staff/overview')
        .expect(401);
    });
  });
});
