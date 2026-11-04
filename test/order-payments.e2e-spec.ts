import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  MenuCategoryKind,
  OrderStatus,
  PaymentMethod,
  ReservationSource,
  ReservationStatus,
  StaffRole,
  StockKind,
  StockLocation,
  StockMovementType,
  TableKind,
} from '../generated/cnc-client';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { ADMIN_REASON_MESSAGE } from '../src/common/admin-reason';
import { addDays } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { IDEMPOTENCY_KEY_REQUIRED } from '../src/idempotency/idempotency-key.decorator';
import { IDEMPOTENCY_KEY_REUSED } from '../src/idempotency/idempotency.service';
import {
  approvalLimitMessage,
  dailyLimitMessage,
  LIMITED_DECISIONS,
  OWNER_ONLY_ACTIONS,
  ownerOnlyMessage,
} from '../src/money-control/money-control.service';
import {
  BAR_POS_ONLY_MESSAGE,
  BELOW_PAID_MESSAGE,
  CANCEL_PART_PAID_MESSAGE,
  CANCEL_STAGE_MESSAGE,
  DEPOSIT_INVALID_MESSAGE,
  DEPOSIT_RESERVATION_MESSAGE,
  DEPOSIT_USED_MESSAGE,
  DISCOUNT_INVALID_MESSAGE,
  DISCOUNT_STAGE_MESSAGE,
  ORDER_LOCKED_MESSAGE,
  ORDER_NOT_FOUND_MESSAGE,
  PART_PAY_LESS_MESSAGE,
  PART_PAY_STAGE_MESSAGE,
  PAYMENT_CONFIRM_FIRST_MESSAGE,
  PAYMENT_EMPTY_MESSAGE,
  PAYMENT_METHOD_MESSAGE,
  PAYMENT_MISSING_MESSAGE,
  PAYMENT_OPEN_MESSAGE,
  PAYMENT_POSITIVE_MESSAGE,
  REOPEN_PREVIOUS_DAY_MESSAGE,
  REOPEN_STAGE_MESSAGE,
  REVERSE_STAGE_MESSAGE,
  SETTLE_EXACT_MESSAGE,
  SETTLE_STAGE_MESSAGE,
  TRANSFER_DETAILS_MESSAGE,
} from '../src/orders/order-messages';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { drawNumber } from '../src/prisma/sequences';
import { StockLedgerService } from '../src/stock/stock-ledger.service';
import { insufficientStockMessage } from '../src/stock/stock-messages';
import { createTestApp } from './create-test-app';
import { createSeededSettingsIfMissing } from './seeded-settings';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * Point of Sale's money (C4-5) through HTTP and against Postgres:
 * order.payment, order.partPay, order.settle (exact cover, splits, deposit
 * credit), order.discount (the Owner Approval Limit and the daily ledger),
 * order.cancel (with its cancellation docket), order.reopen and
 * order.reverse (the Owner only), and the Bar stock a settlement takes and
 * a reversal returns, exactly once each.
 *
 * The demo's `domain.test.cjs`, `payments.test.cjs`, `revision.test.cjs`
 * and `owner.test.cjs` cases these commands own are ported here by name.
 * The race of two settles on one bill (C4-10's acceptance case) is here
 * too, with the stock it must deduct once.
 *
 * Every dish, table, stock item and account is run-unique and never
 * removed; the suite never edits a seeded row or the settings. Opening
 * balances go in through `StockLedgerService`, as a stock count would put
 * them (Q11). A state no route can reach today (a bill carried from
 * yesterday, a booking's deposit, D38) is written directly.
 */
describe('Order payments and corrections (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let ledger: StockLedgerService;

  const token: Partial<Record<StaffRole, string>> = {};
  const staffId: Partial<Record<StaffRole, string>> = {};
  /** A second cashier, for the two-till race. */
  let secondCashierToken: string;
  /** A manager used only by the daily-limit case, so their day starts empty. */
  let dailyManagerToken: string;
  let dailyManagerId: string;

  const tag = randomUUID().slice(0, 8);

  let approvalLimitKobo: number;
  let dailyLimitOn: boolean;
  let dailyLimitKobo: number;

  let tableId: string;
  /** A table of its own for the deposit credit case. */
  let depositTableId: string;
  let riceId: string;
  /** A dish dearer than the Owner Approval Limit. */
  let feastId: string;
  let lagerId: string;
  let lagerStockId: string;
  let lagerName: string;
  let maltId: string;
  let maltStockId: string;
  /** A drink with no paired Bar stock item (a broken pairing). */
  let unpairedDrinkId: string;

  const RICE_PRICE = 650000;
  const LAGER_PRICE = 250000;
  const MALT_PRICE = 150000;
  const OPENING_BAR_STOCK = 60;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    ledger = app.get(StockLedgerService, { strict: false });

    await createSeededSettingsIfMissing(prisma);
    ({ approvalLimitKobo, dailyLimitOn, dailyLimitKobo } =
      await prisma.settings.findUniqueOrThrow({
        where: { singleton: true },
        select: {
          approvalLimitKobo: true,
          dailyLimitOn: true,
          dailyLimitKobo: true,
        },
      }));

    const tokens = app.get(CncTokenService, { strict: false });
    const account = async (role: StaffRole, label: string) => {
      const made = await createStaffAccount(prisma, role, {
        emailPrefix: 'payments',
        name: `Payments ${label} ${tag}`,
      });

      return { id: made.id, token: await accessTokenFor(tokens, made.id) };
    };

    for (const role of [
      StaffRole.OWNER,
      StaffRole.MANAGER,
      StaffRole.CASHIER,
      StaffRole.WAITER,
      StaffRole.BARTENDER,
      StaffRole.KITCHEN,
    ]) {
      const made = await account(role, role.toLowerCase());
      token[role] = made.token;
      staffId[role] = made.id;
    }

    secondCashierToken = (await account(StaffRole.CASHIER, 'second cashier'))
      .token;
    const dailyManager = await account(StaffRole.MANAGER, 'daily manager');
    dailyManagerToken = dailyManager.token;
    dailyManagerId = dailyManager.id;

    const venue = await prisma.venue.create({
      data: {
        slug: `payments-${tag}`,
        customerTitle: `Payments ${tag}`,
        staffName: `Payments ${tag}`,
        bigParty: 4,
        sort: 901,
      },
    });
    const table = (code: string) =>
      prisma.diningTable.create({
        data: {
          venueId: venue.id,
          code,
          name: `Table ${code} ${tag}`,
          kind: TableKind.BOOTH,
          capacity: 4,
        },
      });
    tableId = (await table('B1')).id;
    depositTableId = (await table('B2')).id;

    const category = async (kind: MenuCategoryKind, department: Department) => {
      const menuCategory = await prisma.menuCategory.create({
        data: {
          slug: `payments-${kind.toLowerCase()}-${tag}`,
          title: `Payments ${kind} ${tag}`,
          kind,
          sort: 901,
        },
      });
      const staffCategory = await prisma.staffCategory.create({
        data: {
          name: `Payments ${department} ${tag}`,
          department,
          menuCategoryId: menuCategory.id,
        },
      });

      return {
        menuCategoryId: menuCategory.id,
        staffCategoryId: staffCategory.id,
      };
    };

    const food = await category(MenuCategoryKind.FOOD, Department.RESTAURANT);
    const drinks = await category(MenuCategoryKind.DRINKS, Department.BAR);
    const item = (
      department: Department,
      slug: string,
      name: string,
      priceKobo: number,
    ) =>
      prisma.menuItem.create({
        data: {
          slug: `payments-${slug}-${tag}`,
          department,
          ...(department === Department.RESTAURANT ? food : drinks),
          name: `${name} ${tag}`,
          priceKobo,
        },
      });
    const pair = (drink: { id: string; name: string }) =>
      prisma.stockItem.create({
        data: {
          name: drink.name,
          kind: StockKind.BAR,
          unit: 'serving',
          pack: 'batch',
          factor: 12,
          minimum: 12,
          menuItemId: drink.id,
        },
      });

    riceId = (await item(Department.RESTAURANT, 'rice', 'Rice', RICE_PRICE)).id;
    feastId = (
      await item(
        Department.RESTAURANT,
        'feast',
        'Feast',
        approvalLimitKobo + 100,
      )
    ).id;

    const lager = await item(Department.BAR, 'lager', 'Lager', LAGER_PRICE);
    lagerId = lager.id;
    lagerName = lager.name;
    lagerStockId = (await pair(lager)).id;

    const malt = await item(Department.BAR, 'malt', 'Malt', MALT_PRICE);
    maltId = malt.id;
    maltStockId = (await pair(malt)).id;

    unpairedDrinkId = (
      await item(Department.BAR, 'unpaired', 'Unpaired', 100000)
    ).id;

    // Opening balances, as the C4 gate enters them by stock count (Q11).
    await prisma.$transaction(async (tx) => {
      for (const stockItemId of [lagerStockId, maltStockId]) {
        await ledger.move(tx, {
          stockItemId,
          location: StockLocation.BAR,
          qty: OPENING_BAR_STOCK,
          type: StockMovementType.STOCK_COUNT,
          ref: 'Opening balance',
          staffId: staffId[StaffRole.OWNER]!,
        });
      }
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const bearer = (value: string) => ({ Authorization: `Bearer ${value}` });
  const auth = (role: StaffRole) => bearer(token[role]!);
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;
  /**
   * The sentences of a 400, whether the ValidationPipe (a list) or the
   * service (one string) refused it: a check this suite does not mean to
   * pin to one layer.
   */
  const sentencesOf = (response: request.Response) =>
    [messageOf(response)].flat();
  const today = () => watToday(new Date());

  interface Payment {
    number: string;
    method: PaymentMethod;
    amountKobo: number;
    sender: string;
    reference: string;
    part: boolean;
    reversed: boolean;
    staffName: string | null;
    businessDate: string;
  }

  interface Docket {
    ref: string;
    revision: number;
    items: unknown[];
    cancellation: boolean;
  }

  interface Order {
    id: string;
    number: string;
    department: Department;
    status: OrderStatus;
    businessDate: string;
    revision: number;
    discountKobo: number;
    depositKobo: number;
    reservationId: string | null;
    settledAt: string | null;
    editable: boolean;
    partPaid: boolean;
    totals: {
      subtotalKobo: number;
      discountKobo: number;
      serviceKobo: number;
      vatKobo: number;
      totalKobo: number;
      dueKobo: number;
      paidKobo: number;
      balanceKobo: number;
    };
    payments: Payment[];
    latestDocket: Docket | null;
    version: number;
  }

  type Ref = Pick<Order, 'id' | 'version'>;
  type Body = Record<string, unknown>;

  const open = async (
    department: Department = Department.BAR,
    body: Body = {},
  ): Promise<Order> =>
    (
      await request(server())
        .post('/api/v1/staff/orders')
        .set(auth(StaffRole.CASHIER))
        .set('Idempotency-Key', randomUUID())
        .send({ department, ...body })
        .expect(201)
    ).body as Order;

  const line = async (
    order: Ref,
    menuItemId: string,
    qty: number,
  ): Promise<Order> =>
    (
      await request(server())
        .put(`/api/v1/staff/orders/${order.id}/lines`)
        .set(auth(StaffRole.CASHIER))
        .send({ version: order.version, menuItemId, qty })
        .expect(200)
    ).body as Order;

  const confirm = async (order: Ref): Promise<Order> =>
    (
      (
        await request(server())
          .post(`/api/v1/staff/orders/${order.id}/confirm`)
          .set(auth(StaffRole.WAITER))
          .send({ version: order.version })
          .expect(200)
      ).body as { order: Order }
    ).order;

  const read = async (id: string): Promise<Order> =>
    (
      await request(server())
        .get(`/api/v1/staff/orders/${id}`)
        .set(auth(StaffRole.CASHIER))
        .expect(200)
    ).body as Order;

  /** Who calls: a role's account, or another account by its token. */
  type Caller = StaffRole | { token: string };

  /** POST one of the order's command routes with the bill's version. */
  const command = (
    path: string,
    caller: Caller,
    order: Ref,
    body: Body = {},
    key?: string,
  ) => {
    const call = request(server())
      .post(`/api/v1/staff/orders/${order.id}/${path}`)
      .set(typeof caller === 'object' ? bearer(caller.token) : auth(caller));

    if (key !== undefined) call.set('Idempotency-Key', key);

    return call.send({ version: order.version, ...body });
  };

  const proceed = (caller: Caller, order: Ref) =>
    command('payment', caller, order);
  const partPay = (
    caller: Caller,
    order: Ref,
    payments: Body[],
    key: string = randomUUID(),
  ) => command('part-payments', caller, order, { payments }, key);
  const settle = (
    caller: Caller,
    order: Ref,
    payments: Body[],
    extra: Body = {},
    key: string = randomUUID(),
  ) => command('settle', caller, order, { payments, ...extra }, key);
  const discount = (
    caller: Caller,
    order: Ref,
    amountKobo: unknown,
    reason = 'Regular guest',
  ) => command('discount', caller, order, { amountKobo, reason });
  /** A correction; a `null` reason sends none. */
  const correct = (
    path: 'cancel' | 'reopen' | 'reverse',
    caller: Caller,
    order: Ref,
    reason: string | null = 'Wrong bill',
  ) => command(path, caller, order, reason === null ? {} : { reason });

  const cash = (amountKobo: number) => ({ method: 'CASH', amountKobo });

  /** A Bar bill of `qty` lagers, awaiting payment. */
  const barBill = async (qty = 4): Promise<Order> => {
    const order = await line(await open(), lagerId, qty);
    return (await proceed(StaffRole.CASHIER, order).expect(200)).body as Order;
  };

  /** A Restaurant bill of rice, sent to the kitchen and awaiting payment. */
  const foodBill = async (body: Body = {}): Promise<Order> => {
    const order = await confirm(
      await line(await open(Department.RESTAURANT, body), riceId, 2),
    );
    return (await proceed(StaffRole.CASHIER, order).expect(200)).body as Order;
  };

  /** Settle a bill with one cash payment of its whole balance. */
  const settleInFull = async (
    order: Order,
    role: StaffRole = StaffRole.CASHIER,
  ): Promise<Order> =>
    (await settle(role, order, [cash(order.totals.balanceKobo)]).expect(200))
      .body as Order;

  const barBalance = async (stockItemId: string) =>
    (
      await prisma.stockBalance.findUnique({
        where: {
          stockItemId_location: { stockItemId, location: StockLocation.BAR },
        },
        select: { qty: true },
      })
    )?.qty ?? 0;

  const movementsFor = (number: string) =>
    prisma.stockMovement.findMany({
      where: { ref: number },
      orderBy: { createdAt: 'asc' },
      select: { stockItemId: true, qty: true, type: true, location: true },
    });

  describe('order.payment', () => {
    it('unconfirmed food changes cannot proceed to payment', async () => {
      let order = await line(await open(Department.RESTAURANT), riceId, 1);

      const unsent = await proceed(StaffRole.WAITER, order).expect(409);
      expect(messageOf(unsent)).toBe(PAYMENT_CONFIRM_FIRST_MESSAGE);

      order = await line(await confirm(order), riceId, 2);
      const changed = await proceed(StaffRole.WAITER, order).expect(409);
      expect(messageOf(changed)).toBe(PAYMENT_CONFIRM_FIRST_MESSAGE);

      order = await confirm(order);
      const paying = (await proceed(StaffRole.WAITER, order).expect(200))
        .body as Order;
      expect(paying.status).toBe(OrderStatus.PAYMENT);
      expect(paying.editable).toBe(false);
      expect(paying.version).toBe(order.version + 1);
    });

    it('refuses an empty bill and a bill that is not open', async () => {
      const empty = await open();
      const refused = await proceed(StaffRole.CASHIER, empty).expect(409);
      expect(messageOf(refused)).toBe(PAYMENT_EMPTY_MESSAGE);

      const paying = await barBill(1);
      const again = await proceed(StaffRole.CASHIER, paying).expect(409);
      expect(messageOf(again)).toBe(PAYMENT_OPEN_MESSAGE);
    });

    it('is for the Point of Sale roles, a Bartender on Bar bills only', async () => {
      const bar = await line(await open(), lagerId, 1);
      const kitchen = await proceed(StaffRole.KITCHEN, bar).expect(403);
      expect(messageOf(kitchen)).toBe(ROLE_REFUSED_MESSAGE);

      const food = await confirm(
        await line(await open(Department.RESTAURANT), riceId, 1),
      );
      const bartender = await proceed(StaffRole.BARTENDER, food).expect(403);
      expect(messageOf(bartender)).toBe(BAR_POS_ONLY_MESSAGE);

      await proceed(StaffRole.BARTENDER, bar).expect(200);

      const missing = await proceed(StaffRole.CASHIER, {
        id: 'no-such-order',
        version: 0,
      }).expect(404);
      expect(messageOf(missing)).toBe(ORDER_NOT_FOUND_MESSAGE);
    });

    it('midnight freezes yesterday’s items while allowing payment and settlement', async () => {
      const order = await line(await open(), lagerId, 1);
      await prisma.order.update({
        where: { id: order.id },
        data: { businessDate: addDays(today(), -1) },
      });

      const paying = (await proceed(StaffRole.CASHIER, order).expect(200))
        .body as Order;
      const settled = await settleInFull(paying);
      expect(settled.status).toBe(OrderStatus.SETTLED);
      // The money belongs to the day it was taken, not the bill's day.
      expect(settled.payments[0].businessDate).not.toBe(settled.businessDate);
    });
  });

  describe('order.partPay', () => {
    it('a part payment keeps the bill in Payment and lowers the balance', async () => {
      const order = await barBill();
      const total = order.totals.totalKobo;

      const response = await partPay(StaffRole.CASHIER, order, [
        cash(100000),
      ]).expect(201);
      const paid = response.body as Order;

      expect(paid.status).toBe(OrderStatus.PAYMENT);
      expect(paid.totals.paidKobo).toBe(100000);
      expect(paid.totals.balanceKobo).toBe(total - 100000);
      expect(paid.partPaid).toBe(true);
      expect(paid.payments).toHaveLength(1);
      expect(paid.payments[0]).toMatchObject({
        method: PaymentMethod.CASH,
        amountKobo: 100000,
        part: true,
        reversed: false,
      });
      expect(paid.payments[0].number).toMatch(/^PAY-\d{6,}$/);

      const audit = await prisma.auditLog.findFirst({
        where: { ref: order.number },
        orderBy: { at: 'desc' },
        select: { action: true },
      });
      expect(audit?.action).toBe('order.partPay');
    });

    it('part payments work for card, transfer and split', async () => {
      let order = await barBill();

      order = (
        await partPay(StaffRole.CASHIER, order, [
          { method: 'CARD', amountKobo: 50000, reference: 'T1' },
        ]).expect(201)
      ).body as Order;

      const noSender = await partPay(StaffRole.CASHIER, order, [
        { method: 'TRANSFER', amountKobo: 50000 },
      ]).expect(400);
      expect(messageOf(noSender)).toBe(TRANSFER_DETAILS_MESSAGE);

      order = (
        await partPay(StaffRole.BARTENDER, order, [
          {
            method: 'TRANSFER',
            amountKobo: 30000,
            sender: 'Ada',
            reference: 'REF1',
          },
          cash(20000),
        ]).expect(201)
      ).body as Order;

      expect(order.totals.paidKobo).toBe(100000);
      expect(order.payments.map((payment) => payment.method)).toEqual([
        PaymentMethod.CARD,
        PaymentMethod.TRANSFER,
        PaymentMethod.CASH,
      ]);
      expect(new Set(order.payments.map((p) => p.number)).size).toBe(3);
      expect(order.payments[1]).toMatchObject({
        sender: 'Ada',
        reference: 'REF1',
      });
    });

    it('a part payment must be less than the balance', async () => {
      const order = await barBill();

      for (const payments of [
        [cash(order.totals.balanceKobo)],
        [cash(0)],
        [cash(order.totals.balanceKobo + 1)],
      ]) {
        const refused = await partPay(
          StaffRole.CASHIER,
          order,
          payments,
        ).expect(400);
        expect(messageOf(refused)).toBe(PART_PAY_LESS_MESSAGE);
      }

      for (const [body, sentence] of [
        [{ payments: [] }, PAYMENT_MISSING_MESSAGE],
        [{ payments: 'cash' }, PAYMENT_MISSING_MESSAGE],
        [{}, PAYMENT_MISSING_MESSAGE],
        [
          { payments: [{ method: 'CASH', amountKobo: -50 }, cash(10)] },
          PART_PAY_LESS_MESSAGE,
        ],
        [
          { payments: [cash(15), { method: 'CASH', amountKobo: -5 }] },
          PAYMENT_POSITIVE_MESSAGE,
        ],
        [
          { payments: [{ method: 'ONLINE', amountKobo: 10 }] },
          PAYMENT_METHOD_MESSAGE,
        ],
      ] as const) {
        const refused = await command(
          'part-payments',
          StaffRole.CASHIER,
          order,
          body,
          randomUUID(),
        ).expect(400);
        expect(sentencesOf(refused)).toEqual([sentence]);
      }

      expect((await read(order.id)).payments).toHaveLength(0);
    });

    it('only cashiers, bartenders and managers take part payments', async () => {
      const order = await barBill();

      const waiter = await partPay(StaffRole.WAITER, order, [cash(100)]).expect(
        403,
      );
      expect(messageOf(waiter)).toBe(ROLE_REFUSED_MESSAGE);
      await partPay(StaffRole.KITCHEN, order, [cash(100)]).expect(403);

      await partPay(StaffRole.MANAGER, order, [cash(100)]).expect(201);
    });

    it('needs the bill at Payment first', async () => {
      const order = await line(await open(), lagerId, 1);
      const refused = await partPay(StaffRole.CASHIER, order, [
        cash(100),
      ]).expect(409);
      expect(messageOf(refused)).toBe(PART_PAY_STAGE_MESSAGE);
    });

    it('needs an Idempotency-Key, and a retry takes the money once', async () => {
      const order = await barBill();

      const missing = await command('part-payments', StaffRole.CASHIER, order, {
        payments: [cash(100)],
      }).expect(400);
      expect(messageOf(missing)).toBe(IDEMPOTENCY_KEY_REQUIRED);

      const key = randomUUID();
      const first = await partPay(
        StaffRole.CASHIER,
        order,
        [cash(100)],
        key,
      ).expect(201);
      const retry = await partPay(
        StaffRole.CASHIER,
        order,
        [cash(100)],
        key,
      ).expect(201);
      expect(retry.body).toEqual(first.body);
      await expect(
        prisma.payment.count({ where: { orderId: order.id } }),
      ).resolves.toBe(1);

      const reused = await partPay(
        StaffRole.CASHIER,
        order,
        [cash(200)],
        key,
      ).expect(409);
      expect(messageOf(reused)).toBe(IDEMPOTENCY_KEY_REUSED);
    });
  });

  describe('order.settle', () => {
    it('settlement takes only the remaining balance after part payments', async () => {
      let order = await barBill();
      const total = order.totals.totalKobo;

      order = (
        await partPay(StaffRole.CASHIER, order, [cash(100000)]).expect(201)
      ).body as Order;

      const whole = await settle(StaffRole.CASHIER, order, [
        cash(total),
      ]).expect(400);
      expect(messageOf(whole)).toBe(SETTLE_EXACT_MESSAGE);

      const settled = (
        await settle(StaffRole.CASHIER, order, [
          { method: 'CARD', amountKobo: total - 100000 },
        ]).expect(200)
      ).body as Order;

      expect(settled.status).toBe(OrderStatus.SETTLED);
      expect(settled.settledAt).not.toBeNull();
      expect(settled.totals.paidKobo).toBe(total);
      expect(settled.totals.balanceKobo).toBe(0);
      expect(settled.payments.map((p) => [p.part, p.amountKobo])).toEqual([
        [true, 100000],
        [false, total - 100000],
      ]);
    });

    it('bar edits and payment handoff do not deduct stock; settlement deducts once', async () => {
      const start = await barBalance(lagerStockId);
      let order = await line(await open(), lagerId, 3);
      expect(await barBalance(lagerStockId)).toBe(start);

      order = (await proceed(StaffRole.CASHIER, order).expect(200))
        .body as Order;
      expect(await barBalance(lagerStockId)).toBe(start);

      const settled = await settleInFull(order, StaffRole.BARTENDER);
      expect(await barBalance(lagerStockId)).toBe(start - 3);

      const again = await settle(StaffRole.CASHIER, settled, [
        cash(order.totals.totalKobo),
      ]).expect(409);
      expect(messageOf(again)).toBe(SETTLE_STAGE_MESSAGE);
      expect(await barBalance(lagerStockId)).toBe(start - 3);

      expect(await movementsFor(order.number)).toEqual([
        {
          stockItemId: lagerStockId,
          qty: -3,
          type: StockMovementType.BAR_SALE,
          location: StockLocation.BAR,
        },
      ]);
      await expect(
        prisma.docket.count({ where: { orderId: order.id } }),
      ).resolves.toBe(0);
    });

    it('cash or transfer validation failures are atomic', async () => {
      const order = await barBill();
      const start = await barBalance(lagerStockId);

      const transfer = await settle(StaffRole.CASHIER, order, [
        { method: 'TRANSFER', amountKobo: order.totals.totalKobo },
      ]).expect(400);
      expect(messageOf(transfer)).toBe(TRANSFER_DETAILS_MESSAGE);

      const short = await settle(StaffRole.CASHIER, order, [cash(100)]).expect(
        400,
      );
      expect(messageOf(short)).toBe(SETTLE_EXACT_MESSAGE);

      const after = await read(order.id);
      expect(after.status).toBe(OrderStatus.PAYMENT);
      expect(after.payments).toHaveLength(0);
      expect(after.version).toBe(order.version);
      expect(await barBalance(lagerStockId)).toBe(start);
    });

    it('insufficient bar stock prevents both payment and sale completion', async () => {
      const start = await barBalance(lagerStockId);
      const order = await barBill(start + 1);

      const refused = await settle(StaffRole.CASHIER, order, [
        cash(order.totals.totalKobo),
      ]).expect(409);
      expect(messageOf(refused)).toBe(
        insufficientStockMessage(StockLocation.BAR, lagerName),
      );

      const after = await read(order.id);
      expect(after.status).toBe(OrderStatus.PAYMENT);
      expect(after.payments).toHaveLength(0);
      expect(await barBalance(lagerStockId)).toBe(start);
      expect(await movementsFor(order.number)).toEqual([]);
    });

    it('names the first short drink on the bill, as the demo does, whatever the stock ids', async () => {
      // Two drinks the Bar holds none of, the later id first on the bill.
      const drinks: {
        menuItemId: string;
        stockItemId: string;
        name: string;
      }[] = [];
      for (const label of ['Zobo', 'Chapman']) {
        const drink = await prisma.menuItem.findFirstOrThrow({
          where: { id: lagerId },
          select: { menuCategoryId: true, staffCategoryId: true },
        });
        const made = await prisma.menuItem.create({
          data: {
            slug: `payments-${label.toLowerCase()}-${tag}`,
            department: Department.BAR,
            menuCategoryId: drink.menuCategoryId,
            staffCategoryId: drink.staffCategoryId,
            name: `${label} ${tag}`,
            priceKobo: 100000,
          },
        });
        const stock = await prisma.stockItem.create({
          data: {
            name: made.name,
            kind: StockKind.BAR,
            unit: 'serving',
            pack: 'batch',
            factor: 12,
            minimum: 12,
            menuItemId: made.id,
          },
        });
        drinks.push({
          menuItemId: made.id,
          stockItemId: stock.id,
          name: made.name,
        });
      }
      drinks.sort((a, b) => (a.stockItemId < b.stockItemId ? 1 : -1));
      const [first, second] = drinks;

      let order = await line(await open(), first.menuItemId, 1);
      order = await line(order, second.menuItemId, 1);
      order = (await proceed(StaffRole.CASHIER, order).expect(200))
        .body as Order;

      const refused = await settle(StaffRole.CASHIER, order, [
        cash(order.totals.totalKobo),
      ]).expect(409);
      expect(messageOf(refused)).toBe(
        insufficientStockMessage(StockLocation.BAR, first.name),
      );
      expect(await movementsFor(order.number)).toEqual([]);
    });

    it('refuses a drink with no paired Bar stock item, and records nothing', async () => {
      let order = await line(await open(), unpairedDrinkId, 1);
      order = (await proceed(StaffRole.CASHIER, order).expect(200))
        .body as Order;

      const refused = await settle(StaffRole.CASHIER, order, [
        cash(order.totals.totalKobo),
      ]).expect(404);
      expect(messageOf(refused)).toBe('Stock item not found.');
      expect((await read(order.id)).payments).toHaveLength(0);
    });

    it('split settlement records exact component amounts', async () => {
      let order = await line(await open(), lagerId, 2);
      order = await line(order, maltId, 1);
      order = (await proceed(StaffRole.CASHIER, order).expect(200))
        .body as Order;
      const total = order.totals.totalKobo;
      const lager = await barBalance(lagerStockId);
      const malt = await barBalance(maltStockId);

      const settled = (
        await settle(StaffRole.CASHIER, order, [
          cash(10000),
          { method: 'CARD', amountKobo: 20000 },
          {
            method: 'TRANSFER',
            amountKobo: total - 30000,
            sender: 'Musa',
            reference: 'TRF-9',
          },
        ]).expect(200)
      ).body as Order;

      expect(settled.payments.map((p) => p.amountKobo)).toEqual([
        10000,
        20000,
        total - 30000,
      ]);
      expect(settled.payments.reduce((sum, p) => sum + p.amountKobo, 0)).toBe(
        total,
      );
      expect(new Set(settled.payments.map((p) => p.number)).size).toBe(3);
      expect(await barBalance(lagerStockId)).toBe(lager - 2);
      expect(await barBalance(maltStockId)).toBe(malt - 1);
    });

    it('food settlement never repeats a kitchen deduction', async () => {
      // Rice has a comparison rule and a kitchen portion with a balance, so
      // a settle that deducted food by the rule, or repeated the kitchen
      // entry, would have something to move.
      const portion = await prisma.stockItem.create({
        data: {
          name: `Rice portion ${tag}`,
          kind: StockKind.KITCHEN,
          unit: 'portion',
          pack: 'tray',
          factor: 10,
          minimum: 10,
        },
      });
      await prisma.$transaction((tx) =>
        ledger.move(tx, {
          stockItemId: portion.id,
          location: StockLocation.KITCHEN,
          qty: 20,
          type: StockMovementType.STOCK_COUNT,
          ref: 'Opening balance',
          staffId: staffId[StaffRole.OWNER]!,
        }),
      );
      await request(server())
        .put(`/api/v1/staff/kitchen-mappings/${riceId}`)
        .set(auth(StaffRole.OWNER))
        .send({ lines: [{ stockItemId: portion.id, qty: 1 }] })
        .expect(200);

      const sent = await confirm(
        await line(await open(Department.RESTAURANT), riceId, 2),
      );
      const docketRef = sent.latestDocket!.ref;

      await request(server())
        .put(`/api/v1/staff/kitchen/entries/${encodeURIComponent(docketRef)}`)
        .set(auth(StaffRole.KITCHEN))
        .send({ lines: [{ stockItemId: portion.id, qty: 2 }] })
        .expect(200);

      const movements = () =>
        prisma.stockMovement.count({
          where: {
            OR: [
              { stockItemId: portion.id },
              { ref: { in: [sent.number, docketRef] } },
            ],
          },
        });
      const kitchenBalance = async () =>
        (
          await prisma.stockBalance.findUniqueOrThrow({
            where: {
              stockItemId_location: {
                stockItemId: portion.id,
                location: StockLocation.KITCHEN,
              },
            },
            select: { qty: true },
          })
        ).qty;
      const movementsBefore = await movements();
      const balanceBefore = await kitchenBalance();
      expect(balanceBefore).toBe(18);

      const order = (await proceed(StaffRole.CASHIER, sent).expect(200))
        .body as Order;
      await settleInFull(order);

      expect(await movements()).toBe(movementsBefore);
      expect(await kitchenBalance()).toBe(balanceBefore);
    });

    it('settles a bill discounted to nothing with no payment', async () => {
      let order = await line(await open(Department.RESTAURANT), riceId, 1);
      order = (await discount(StaffRole.MANAGER, order, RICE_PRICE).expect(200))
        .body as Order;
      order = (
        await proceed(StaffRole.CASHIER, await confirm(order)).expect(200)
      ).body as Order;
      expect(order.totals.totalKobo).toBe(0);

      const settled = (await settle(StaffRole.CASHIER, order, []).expect(200))
        .body as Order;
      expect(settled.status).toBe(OrderStatus.SETTLED);
      expect(settled.payments).toHaveLength(0);
    });

    it('is for cashiers, bartenders and managers, after Proceed to Payment', async () => {
      const order = await barBill(1);
      const waiter = await settle(StaffRole.WAITER, order, [
        cash(order.totals.totalKobo),
      ]).expect(403);
      expect(messageOf(waiter)).toBe(ROLE_REFUSED_MESSAGE);
      await settle(StaffRole.KITCHEN, order, [cash(1)]).expect(403);

      const unpaid = await line(await open(), lagerId, 1);
      const early = await settle(StaffRole.CASHIER, unpaid, [
        cash(unpaid.totals.totalKobo),
      ]).expect(409);
      expect(messageOf(early)).toBe(SETTLE_STAGE_MESSAGE);
    });

    it('two cashiers settling one bill: one settles, the other is told to refresh, and stock moves once', async () => {
      const start = await barBalance(lagerStockId);
      const order = await barBill(2);
      const payments = [cash(order.totals.totalKobo)];

      const results = await Promise.all([
        settle(StaffRole.CASHIER, order, payments),
        settle({ token: secondCashierToken }, order, payments),
      ]);

      expect(results.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
      expect(
        messageOf(results.find((response) => response.status === 409)!),
      ).toBe(STALE_VERSION_MESSAGE);

      const after = await read(order.id);
      expect(after.status).toBe(OrderStatus.SETTLED);
      expect(after.payments).toHaveLength(1);
      expect(await barBalance(lagerStockId)).toBe(start - 2);
      expect(await movementsFor(order.number)).toHaveLength(1);
    });

    it('one till retrying a settle with its key settles once', async () => {
      const start = await barBalance(lagerStockId);
      const order = await barBill(1);
      const key = randomUUID();
      const payments = [cash(order.totals.totalKobo)];

      const results = await Promise.all([
        settle(StaffRole.CASHIER, order, payments, {}, key),
        settle(StaffRole.CASHIER, order, payments, {}, key),
      ]);

      expect(results.map((response) => response.status)).toEqual([200, 200]);
      expect(results[0].body).toEqual(results[1].body);
      await expect(
        prisma.payment.count({ where: { orderId: order.id } }),
      ).resolves.toBe(1);
      expect(await barBalance(lagerStockId)).toBe(start - 1);
    });

    it('legacy deposit credit cannot be reused across restaurant and bar orders', async () => {
      const booking = await prisma.reservation.create({
        data: {
          number: await drawNumber(prisma, 'reservation'),
          tableId: depositTableId,
          name: `Deposit guest ${tag}`,
          phone: '08000000001',
          businessDate: today(),
          startMinutes: 600,
          party: 2,
          status: ReservationStatus.CHECKED_IN,
          source: ReservationSource.RECEPTION,
          depositKobo: 500000,
        },
      });
      const credit = { depositKobo: 500000, reservationId: booking.id };

      const food = await foodBill({ tableId: depositTableId });
      expect(food.totals.totalKobo).toBeGreaterThan(500000);

      const elsewhere = await foodBill({ tableId });
      const wrongTable = await settle(
        StaffRole.CASHIER,
        elsewhere,
        [cash(elsewhere.totals.totalKobo - 500000)],
        credit,
      ).expect(400);
      expect(messageOf(wrongTable)).toBe(DEPOSIT_RESERVATION_MESSAGE);

      const tooMuch = await settle(StaffRole.CASHIER, food, [], {
        ...credit,
        depositKobo: food.totals.totalKobo + 1,
      }).expect(400);
      expect(messageOf(tooMuch)).toBe(DEPOSIT_INVALID_MESSAGE);

      const settled = (
        await settle(
          StaffRole.CASHIER,
          food,
          [cash(food.totals.totalKobo - 500000)],
          credit,
        ).expect(200)
      ).body as Order;
      expect(settled.depositKobo).toBe(500000);
      expect(settled.reservationId).toBe(booking.id);
      expect(settled.totals.dueKobo).toBe(food.totals.totalKobo - 500000);

      const bar = await barBill(1);
      await prisma.order.update({
        where: { id: bar.id },
        data: { tableId: depositTableId },
      });
      const reused = await settle(
        StaffRole.CASHIER,
        bar,
        [cash(bar.totals.totalKobo - 10000)],
        { depositKobo: 10000, reservationId: booking.id },
      ).expect(409);
      expect(messageOf(reused)).toBe(DEPOSIT_USED_MESSAGE);
      await expect(
        prisma.reservation.findUniqueOrThrow({ where: { id: booking.id } }),
      ).resolves.toMatchObject({ depositUsedKobo: 500000 });

      // A reversal gives the credit back to the booking.
      const reversed = (
        await correct('reverse', StaffRole.OWNER, settled).expect(200)
      ).body as Order;
      expect(reversed).toMatchObject({ depositKobo: 0, reservationId: null });
      await expect(
        prisma.reservation.findUniqueOrThrow({ where: { id: booking.id } }),
      ).resolves.toMatchObject({ depositUsedKobo: 0 });
    });
  });

  describe('order.discount', () => {
    it('discounts above the limit need the Owner', async () => {
      const order = await line(await open(Department.RESTAURANT), feastId, 1);
      expect(order.totals.subtotalKobo).toBeGreaterThan(approvalLimitKobo);

      const within = Math.floor(approvalLimitKobo * 0.8);
      const discounted = (
        await discount(StaffRole.MANAGER, order, within).expect(200)
      ).body as Order;
      expect(discounted.discountKobo).toBe(within);
      expect(discounted.totals.subtotalKobo - within).toBe(
        discounted.totals.subtotalKobo - discounted.totals.discountKobo,
      );

      const above = await discount(
        StaffRole.MANAGER,
        discounted,
        approvalLimitKobo + 100,
      ).expect(403);
      expect(messageOf(above)).toBe(
        approvalLimitMessage(LIMITED_DECISIONS.discount, approvalLimitKobo),
      );
      expect((await read(order.id)).discountKobo).toBe(within);

      const owner = (
        await discount(
          StaffRole.OWNER,
          discounted,
          approvalLimitKobo + 100,
        ).expect(200)
      ).body as Order;
      expect(owner.discountKobo).toBe(approvalLimitKobo + 100);

      // The manager's decision is in the ledger; the Owner is never recorded.
      const rows = await prisma.approvalLedger.findMany({
        where: { ref: order.number },
        select: { staffId: true, amountKobo: true, action: true },
      });
      expect(rows).toEqual([
        {
          staffId: staffId[StaffRole.MANAGER],
          amountKobo: within,
          action: 'order.discount',
        },
      ]);
    });

    it('only the increase counts toward the day', async () => {
      const order = await line(await open(Department.RESTAURANT), riceId, 4);

      let current = (
        await discount(StaffRole.MANAGER, order, 300000).expect(200)
      ).body as Order;
      current = (await discount(StaffRole.MANAGER, current, 100000).expect(200))
        .body as Order;
      current = (await discount(StaffRole.MANAGER, current, 250000).expect(200))
        .body as Order;
      expect(current.discountKobo).toBe(250000);

      const rows = await prisma.approvalLedger.findMany({
        where: { ref: order.number },
        orderBy: { createdAt: 'asc' },
        select: { amountKobo: true },
      });
      expect(rows.map((row) => row.amountKobo)).toEqual([300000, 150000]);
    });

    it('stops a manager at the Daily Approval Limit', async () => {
      if (!dailyLimitOn) return;

      const fits = Math.floor(dailyLimitKobo / approvalLimitKobo);
      let used = 0;

      for (let index = 0; index <= fits; index += 1) {
        const order = await line(await open(Department.RESTAURANT), feastId, 1);
        const response = await discount(
          { token: dailyManagerToken },
          order,
          approvalLimitKobo,
        );

        if (index < fits) {
          expect(response.status).toBe(200);
          used += approvalLimitKobo;
        } else {
          expect(response.status).toBe(403);
          expect(messageOf(response)).toBe(
            dailyLimitMessage(used + approvalLimitKobo, dailyLimitKobo),
          );
          expect((await read(order.id)).discountKobo).toBe(0);
        }
      }

      const ledger = await prisma.approvalLedger.aggregate({
        where: { staffId: dailyManagerId },
        _sum: { amountKobo: true },
      });
      expect(ledger._sum.amountKobo).toBe(used);
    });

    it('applies only before Proceed to Payment, on the opening date', async () => {
      const paying = await foodBill();
      const late = await discount(StaffRole.MANAGER, paying, 100).expect(409);
      expect(messageOf(late)).toBe(DISCOUNT_STAGE_MESSAGE);

      const carried = await line(await open(Department.RESTAURANT), riceId, 1);
      await prisma.order.update({
        where: { id: carried.id },
        data: { businessDate: addDays(today(), -1) },
      });
      const yesterday = await discount(StaffRole.MANAGER, carried, 100).expect(
        409,
      );
      expect(messageOf(yesterday)).toBe(DISCOUNT_STAGE_MESSAGE);
    });

    it('takes a whole amount up to the subtotal, with a reason, from a manager', async () => {
      const order = await line(await open(Department.RESTAURANT), riceId, 1);

      for (const amount of [RICE_PRICE + 1, -1, 10.5, '100']) {
        const refused = await discount(StaffRole.MANAGER, order, amount).expect(
          400,
        );
        expect(sentencesOf(refused)).toEqual([DISCOUNT_INVALID_MESSAGE]);
      }

      const noReason = await discount(
        StaffRole.MANAGER,
        order,
        100,
        '  ',
      ).expect(400);
      expect(messageOf(noReason)).toEqual([ADMIN_REASON_MESSAGE]);

      const cashier = await discount(StaffRole.CASHIER, order, 100).expect(403);
      expect(messageOf(cashier)).toBe(ROLE_REFUSED_MESSAGE);

      const audit = await prisma.auditLog.findMany({
        where: { ref: order.number, action: 'order.discount' },
      });
      expect(audit).toHaveLength(0);
    });
  });

  describe('order.cancel', () => {
    it('an empty generated bill survives and only a manager may cancel it', async () => {
      const order = await open(Department.RESTAURANT);

      const waiter = await correct('cancel', StaffRole.WAITER, order).expect(
        403,
      );
      expect(messageOf(waiter)).toBe(ROLE_REFUSED_MESSAGE);

      const noReason = await correct(
        'cancel',
        StaffRole.MANAGER,
        order,
        null,
      ).expect(400);
      expect(messageOf(noReason)).toEqual([ADMIN_REASON_MESSAGE]);

      const cancelled = (
        await correct('cancel', StaffRole.MANAGER, order, 'Guest left').expect(
          200,
        )
      ).body as { order: Order; docket: Docket | null };
      expect(cancelled.order.status).toBe(OrderStatus.CANCELLED);
      expect(cancelled.docket).toBeNull();

      const next = await open(Department.RESTAURANT);
      expect(next.number).not.toBe(order.number);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { ref: order.number, action: 'order.cancel' },
        select: { reason: true },
      });
      expect(audit.reason).toBe('Guest left');
    });

    it('cancelling confirmed food returns a cancellation docket, leaving manual kitchen work independent', async () => {
      const order = await confirm(
        await line(await open(Department.RESTAURANT), riceId, 2),
      );
      const cancelled = (
        await correct(
          'cancel',
          StaffRole.MANAGER,
          order,
          'Guest cancellation',
        ).expect(200)
      ).body as { order: Order; docket: Docket };

      expect(cancelled.docket).toMatchObject({
        ref: `KOT-${order.number}`,
        revision: 2,
        items: [],
        cancellation: true,
      });
      expect(cancelled.order.revision).toBe(2);
      expect(cancelled.order.latestDocket?.revision).toBe(2);
      // No stock moves: the kitchen's own entries are its own to correct.
      expect(await movementsFor(order.number)).toEqual([]);

      const docket = await request(server())
        .get(`/api/v1/staff/dockets/KOT-${order.number}`)
        .set(auth(StaffRole.KITCHEN))
        .expect(200);
      expect(docket.body).toMatchObject({ revision: 2, cancellation: true });
    });

    it('a part paid bill cannot be cancelled, nor a settled one', async () => {
      const order = await barBill();
      const paid = (
        await partPay(StaffRole.CASHIER, order, [cash(100000)]).expect(201)
      ).body as Order;

      const partPaid = await correct('cancel', StaffRole.MANAGER, paid).expect(
        409,
      );
      expect(messageOf(partPaid)).toBe(CANCEL_PART_PAID_MESSAGE);

      const settled = await settleInFull(paid);
      const done = await correct('cancel', StaffRole.MANAGER, settled).expect(
        409,
      );
      expect(messageOf(done)).toBe(CANCEL_STAGE_MESSAGE);
    });
  });

  describe('order.reopen', () => {
    it('payment handoff locks items until manager reopens with a reason', async () => {
      const order = await barBill(1);

      const locked = await request(server())
        .put(`/api/v1/staff/orders/${order.id}/lines`)
        .set(auth(StaffRole.CASHIER))
        .send({ version: order.version, menuItemId: lagerId, qty: 2 })
        .expect(409);
      expect(messageOf(locked)).toBe(ORDER_LOCKED_MESSAGE);

      const waiter = await correct('reopen', StaffRole.WAITER, order).expect(
        403,
      );
      expect(messageOf(waiter)).toBe(ROLE_REFUSED_MESSAGE);
      const noReason = await correct(
        'reopen',
        StaffRole.MANAGER,
        order,
        null,
      ).expect(400);
      expect(messageOf(noReason)).toEqual([ADMIN_REASON_MESSAGE]);

      const reopened = (
        await correct(
          'reopen',
          StaffRole.MANAGER,
          order,
          'Guest changed selection',
        ).expect(200)
      ).body as Order;
      expect(reopened.status).toBe(OrderStatus.OPEN);
      expect(reopened.editable).toBe(true);
      expect((await line(reopened, lagerId, 2)).totals.subtotalKobo).toBe(
        2 * LAGER_PRICE,
      );
    });

    it('reopens only a bill awaiting payment, and never a carried one', async () => {
      const openBill = await line(await open(), lagerId, 1);
      const notPaying = await correct(
        'reopen',
        StaffRole.MANAGER,
        openBill,
      ).expect(409);
      expect(messageOf(notPaying)).toBe(REOPEN_STAGE_MESSAGE);

      const carried = await barBill(1);
      await prisma.order.update({
        where: { id: carried.id },
        data: { businessDate: addDays(today(), -1) },
      });
      const yesterday = await correct(
        'reopen',
        StaffRole.MANAGER,
        carried,
      ).expect(409);
      expect(messageOf(yesterday)).toBe(REOPEN_PREVIOUS_DAY_MESSAGE);
    });

    it('a reopened part-paid bill cannot be cut below its part payments, and still settles', async () => {
      // What three lagers come to with this suite's rates.
      const threeKobo = (await line(await open(), lagerId, 3)).totals.totalKobo;
      const order = await barBill(4);
      const start = await barBalance(lagerStockId);

      let bill = (
        await partPay(StaffRole.CASHIER, order, [cash(threeKobo)]).expect(201)
      ).body as Order;
      bill = (await correct('reopen', StaffRole.MANAGER, bill).expect(200))
        .body as Order;

      // Two lagers would leave the guest owing less than they paid.
      const cut = await request(server())
        .put(`/api/v1/staff/orders/${bill.id}/lines`)
        .set(auth(StaffRole.CASHIER))
        .send({ version: bill.version, menuItemId: lagerId, qty: 2 })
        .expect(409);
      expect(messageOf(cut)).toBe(BELOW_PAID_MESSAGE);

      // A discount of one lager would bring it to exactly what was paid;
      // a naira more is below it.
      const discounted = await discount(
        StaffRole.MANAGER,
        bill,
        LAGER_PRICE + 100,
      ).expect(409);
      expect(messageOf(discounted)).toBe(BELOW_PAID_MESSAGE);

      const unchanged = await read(bill.id);
      expect(unchanged.totals.subtotalKobo).toBe(4 * LAGER_PRICE);
      expect(unchanged.discountKobo).toBe(0);
      expect(unchanged.version).toBe(bill.version);

      // Down to exactly what was paid is allowed, and settles with nothing.
      bill = await line(bill, lagerId, 3);
      expect(bill.totals.balanceKobo).toBe(0);
      bill = (await proceed(StaffRole.CASHIER, bill).expect(200)).body as Order;

      const settled = (await settle(StaffRole.CASHIER, bill, []).expect(200))
        .body as Order;
      expect(settled.status).toBe(OrderStatus.SETTLED);
      expect(settled.payments.map((p) => p.amountKobo)).toEqual([threeKobo]);
      expect(await barBalance(lagerStockId)).toBe(start - 3);
    });

    it('refuses Proceed to Payment on a bill owing less than was paid', async () => {
      // No route reaches this state now; a repaired row stands in for it.
      const order = await line(await open(), lagerId, 1);
      await prisma.$transaction(async (tx) =>
        tx.payment.create({
          data: {
            number: await drawNumber(tx, 'payment'),
            orderId: order.id,
            method: PaymentMethod.CASH,
            amountKobo: order.totals.totalKobo + 1,
            part: true,
            staffId: staffId[StaffRole.CASHIER]!,
            businessDate: today(),
          },
        }),
      );

      const refused = await proceed(StaffRole.CASHIER, order).expect(409);
      expect(messageOf(refused)).toBe(BELOW_PAID_MESSAGE);
      expect((await read(order.id)).status).toBe(OrderStatus.OPEN);
    });
  });

  describe('order.reverse', () => {
    const ownerOnly = ownerOnlyMessage(OWNER_ONLY_ACTIONS.reverseBill);

    it('only the Owner reverses a paid bill', async () => {
      const settled = await settleInFull(await barBill(2));

      for (const role of [
        StaffRole.MANAGER,
        StaffRole.CASHIER,
        StaffRole.WAITER,
        StaffRole.KITCHEN,
      ]) {
        const refused = await correct('reverse', role, settled).expect(403);
        expect(messageOf(refused)).toBe(ownerOnly);
      }
      expect((await read(settled.id)).status).toBe(OrderStatus.SETTLED);

      const reversed = (
        await correct('reverse', StaffRole.OWNER, settled).expect(200)
      ).body as Order;
      expect(reversed.status).toBe(OrderStatus.PAYMENT);
      expect(reversed.settledAt).toBeNull();
    });

    it('settlement reversal restores bar stock and cannot be applied twice', async () => {
      const before = await barBalance(lagerStockId);
      const order = await barBill(3);
      const settled = await settleInFull(order);
      expect(await barBalance(lagerStockId)).toBe(before - 3);

      const reversed = (
        await correct(
          'reverse',
          StaffRole.OWNER,
          settled,
          'Wrong payment record',
        ).expect(200)
      ).body as Order;
      expect(await barBalance(lagerStockId)).toBe(before);
      expect(reversed.payments.every((payment) => payment.reversed)).toBe(true);
      expect(reversed.totals.paidKobo).toBe(0);
      expect(reversed.totals.balanceKobo).toBe(order.totals.totalKobo);

      const again = await correct('reverse', StaffRole.OWNER, reversed).expect(
        409,
      );
      expect(messageOf(again)).toBe(REVERSE_STAGE_MESSAGE);
      expect(await barBalance(lagerStockId)).toBe(before);

      await expect(
        prisma.payment.count({
          where: { orderId: order.id, reversed: false },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.payment.count({
          where: { orderId: order.id, reversedAt: null },
        }),
      ).resolves.toBe(0);

      // Settled again, it takes fresh money and the drinks leave once more.
      const resettled = await settleInFull(reversed);
      expect(resettled.payments).toHaveLength(2);
      expect(resettled.totals.paidKobo).toBe(order.totals.totalKobo);
      expect(await barBalance(lagerStockId)).toBe(before - 3);
      expect(
        (await movementsFor(order.number)).map((m) => [m.type, m.qty]),
      ).toEqual([
        [StockMovementType.BAR_SALE, -3],
        [StockMovementType.SETTLEMENT_REVERSAL, 3],
        [StockMovementType.BAR_SALE, -3],
      ]);
    });

    it('needs a settled till bill and a reason', async () => {
      const paying = await barBill(1);
      const unsettled = await correct(
        'reverse',
        StaffRole.OWNER,
        paying,
      ).expect(409);
      expect(messageOf(unsettled)).toBe(REVERSE_STAGE_MESSAGE);

      const noReason = await correct(
        'reverse',
        StaffRole.OWNER,
        paying,
        null,
      ).expect(400);
      expect(messageOf(noReason)).toEqual([ADMIN_REASON_MESSAGE]);
    });
  });

  /**
   * CS B1, decision P21: History > View opens a bill through the existing
   * `GET /staff/orders/:id`, for any status. No new route; these tests pin
   * that the read never writes, and who may make it. The brief's "a
   * Cashier reads only their own till and today" is not applied (P21).
   */
  describe('the bill read (CS B1)', () => {
    const readAs = (role: StaffRole, id: string) =>
      request(server()).get(`/api/v1/staff/orders/${id}`).set(auth(role));

    /** Every row a read could leave behind, for one bill and its readers. */
    const footprint = async (order: Pick<Order, 'id' | 'number'>) => ({
      auditForBill: await prisma.auditLog.count({
        where: { ref: order.number },
      }),
      auditByReaders: await prisma.auditLog.count({
        where: {
          staffId: {
            in: [
              staffId[StaffRole.CASHIER]!,
              staffId[StaffRole.WAITER]!,
              staffId[StaffRole.BARTENDER]!,
              staffId[StaffRole.MANAGER]!,
            ],
          },
        },
      }),
      payments: await prisma.payment.count({ where: { orderId: order.id } }),
      dockets: await prisma.docket.count({ where: { orderId: order.id } }),
      order: await prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true, version: true, updatedAt: true },
      }),
    });

    it('bill detail is read only: open, settled and cancelled bills read the same three times and write nothing', async () => {
      const openBill = await confirm(
        await line(await open(Department.RESTAURANT), riceId, 2),
      );
      const settledBill = await settleInFull(await foodBill());
      const cancelledBill = (
        (
          await correct(
            'cancel',
            StaffRole.MANAGER,
            await confirm(
              await line(await open(Department.RESTAURANT), riceId, 1),
            ),
            'Guest left',
          ).expect(200)
        ).body as { order: Order }
      ).order;

      expect(openBill.status).toBe(OrderStatus.OPEN);
      expect(settledBill.status).toBe(OrderStatus.SETTLED);
      expect(cancelledBill.status).toBe(OrderStatus.CANCELLED);

      for (const bill of [openBill, settledBill, cancelledBill]) {
        const before = await footprint(bill);

        const bodies: Order[] = [];
        for (let read = 0; read < 3; read += 1) {
          bodies.push(
            (await readAs(StaffRole.CASHIER, bill.id).expect(200))
              .body as Order,
          );
        }

        expect(bodies[1]).toEqual(bodies[0]);
        expect(bodies[2]).toEqual(bodies[0]);
        expect(bodies[0]).toMatchObject({
          id: bill.id,
          number: bill.number,
          status: bill.status,
          version: bill.version,
        });
        expect(await footprint(bill)).toEqual(before);
      }

      // What History > View prints is in the one answer.
      const settled = (await readAs(StaffRole.CASHIER, settledBill.id))
        .body as Order;
      expect(settled.settledAt).not.toBeNull();
      expect(settled.payments).toHaveLength(1);
      expect(settled.totals.balanceKobo).toBe(0);
      expect(settled.latestDocket?.cancellation).toBe(false);

      const cancelled = (await readAs(StaffRole.CASHIER, cancelledBill.id))
        .body as Order;
      expect(cancelled.latestDocket).toMatchObject({
        revision: 2,
        cancellation: true,
      });
    });

    it('refuses a Bartender a Restaurant bill; a Waiter and a Cashier read a settled one, as managers do', async () => {
      const bill = await settleInFull(await foodBill());
      const before = await footprint(bill);

      const bartender = await readAs(StaffRole.BARTENDER, bill.id).expect(403);
      expect(messageOf(bartender)).toBe(BAR_POS_ONLY_MESSAGE);

      const kitchen = await readAs(StaffRole.KITCHEN, bill.id).expect(403);
      expect(messageOf(kitchen)).toBe(ROLE_REFUSED_MESSAGE);

      const cashier = (await readAs(StaffRole.CASHIER, bill.id).expect(200))
        .body as Order;
      expect(cashier).toMatchObject({
        id: bill.id,
        status: OrderStatus.SETTLED,
      });

      for (const role of [
        StaffRole.WAITER,
        StaffRole.MANAGER,
        StaffRole.OWNER,
      ]) {
        const response = await readAs(role, bill.id).expect(200);
        expect(response.body).toEqual(cashier);
      }

      expect(await footprint(bill)).toEqual(before);

      // A Bartender's own department still reads.
      const bar = await settleInFull(await barBill(1));
      const barRead = await readAs(StaffRole.BARTENDER, bar.id).expect(200);
      expect((barRead.body as Order).status).toBe(OrderStatus.SETTLED);
    });
  });

  describe('the ledger and the history', () => {
    it('keeps each Bar balance equal to the sum of its movements', async () => {
      for (const stockItemId of [lagerStockId, maltStockId]) {
        const sum = await prisma.stockMovement.aggregate({
          where: { stockItemId, location: StockLocation.BAR },
          _sum: { qty: true },
        });
        expect(await barBalance(stockItemId)).toBe(sum._sum.qty ?? 0);
      }
    });

    it('tells a bill’s money story in plain words', async () => {
      const order = await barBill(1);
      const paid = (
        await partPay(StaffRole.CASHIER, order, [cash(1000)]).expect(201)
      ).body as Order;
      await settleInFull(paid);

      const response = await request(server())
        .get('/api/v1/staff/audit')
        .query({ ref: order.number })
        .set(auth(StaffRole.CASHIER))
        .expect(200);
      const rows = (
        response.body as {
          data: { action: string; actionLabel: string; changes: string[] }[];
        }
      ).data;
      const byAction = new Map(rows.map((row) => [row.action, row]));

      expect(byAction.get('order.payment')).toMatchObject({
        actionLabel: 'Payment Received',
        changes: ['Status changed from Open to Payment.'],
      });
      expect(byAction.get('order.partPay')?.actionLabel).toBe('Part Pay');
      expect(byAction.get('order.settle')?.actionLabel).toBe('Order Settled');
      expect(byAction.get('order.settle')?.changes).toContain(
        'Status changed from Payment to Settled.',
      );
    });
  });
});
