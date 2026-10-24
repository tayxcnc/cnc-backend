/*
 * CNC's Paystack key for this suite, set before the app is built so
 * nothing depends on the developer's `.env`. It signs this suite's fake
 * webhooks only: the client is `FakePaystackClient`, and every refund
 * below goes to it, never to Paystack.
 */
const PAYSTACK_KEY = 'sk_test_cnc_online_staff_e2e_not_a_real_key';

process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  OnlineFulfilmentStatus,
  OnlineRefundStatus,
  OrderStatus,
  PaymentMethod,
  StaffRole,
  StockLocation,
  StockMovementType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { ADMIN_REASON_MESSAGE } from '../src/common/admin-reason';
import { IDEMPOTENCY_KEY_REQUIRED } from '../src/idempotency/idempotency-key.decorator';
import { IDEMPOTENCY_KEY_REUSED } from '../src/idempotency/idempotency.service';
import {
  approvalLimitMessage,
  dailyLimitMessage,
  LIMITED_DECISIONS,
  MoneyControlService,
  REFUND_RELEASE_ACTION,
} from '../src/money-control/money-control.service';
import { OnlineBalanceMethod } from '../src/online-orders/dto/online-order.request';
import { OnlineOrdersService } from '../src/online-orders/online-orders.service';
import {
  BALANCE_TRANSFER_MESSAGE,
  CARD_REFUND_LIMIT_MESSAGE,
  EXTRA_MONEY_METHOD_MESSAGE,
  INVALID_FULFILMENT_STATUS_MESSAGE,
  NEXT_STAGE_MESSAGE,
  NO_ADJUSTMENT_MESSAGE,
  ONLINE_ORDER_CLOSED_MESSAGE,
  ONLINE_ORDER_NOT_FOUND_MESSAGE,
  OUTSTANDING_BALANCE_MESSAGE,
  REFUND_ID_MESSAGE,
  REFUND_NOT_UNCONFIRMED_MESSAGE,
  REFUND_REFUSED_MESSAGE,
  REFUND_UNCONFIRMED_MESSAGE,
  SELECT_ACTIVE_ONLINE_ORDER_MESSAGE,
  SELECT_ONLINE_ORDER_MESSAGE,
  STATUS_MODE_MESSAGE,
  ZONE_BEFORE_DISPATCH_MESSAGE,
} from '../src/online-orders/online-order-messages';
import {
  OnlineRefundsService,
  REFUND_PROVIDER_REF_PREFIX,
} from '../src/online-orders/online-refunds.service';
import {
  PaystackRefusedError,
  PaystackUnavailableError,
} from '../src/payments/paystack-client';
import { WebhookDispatcherService } from '../src/payments/webhook-dispatcher.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { createTestApp } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import { type FakePaystackClient, fakePaystack } from './fake-paystack-client';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { chargeSuccessBody, postSignedWebhook } from './paystack-webhooks';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

interface Money {
  billTotalKobo: number;
  feeKobo: number;
  totalKobo: number;
  paidKobo: number;
  balanceKobo: number;
  cardRefundableKobo: number;
}

interface Detail {
  id: string;
  number: string;
  orderId: string;
  orderNumber: string;
  mode: string;
  address: Record<string, string> | null;
  addressText: string;
  fulfilmentStatus: OnlineFulfilmentStatus;
  contactName: string;
  contactPhone: string;
  note: string;
  money: Money;
  version: number;
  order: {
    status: OrderStatus;
    lines: {
      menuItemId: string;
      option: string;
      qty: number;
      unitPriceKobo: number;
    }[];
    payments: {
      number: string;
      method: PaymentMethod;
      amountKobo: number;
      reversed: boolean;
    }[];
  };
  adjustments: { action: string; amountKobo: number; settled: boolean }[];
  refunds: {
    id: string;
    amountKobo: number;
    status: OnlineRefundStatus;
    providerRefundId: string | null;
  }[];
}

interface Docket {
  ref: string;
  revision: number;
  fulfilment: string | null;
  items: { menuItemId: string; qty: number }[];
  cancellation: boolean;
}

interface Change {
  onlineOrder: Detail;
  docket: Docket | null;
}

/**
 * Staff Online Orders (plan §5.4, §6.2, §7.4 steps 6 and 7; card C7-4),
 * through HTTP: the Cashier's next stage, the managers' corrections,
 * edits (Restaurant and Bar), zone changes (Q27), cancellations (Q8) and
 * the money (Q26 card refunds through the fake Paystack, Q34 Cash and
 * Transfer), with the approval limits and the daily ledger.
 *
 * On a database of its own with the real seeds and the clock faked from
 * the next noon in Jos (as the online orders suite), so every web order
 * here is paid by a signed fake webhook and its Bar balances are its own.
 */
describe('Online Orders: the staff commands (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let dispatcher: WebhookDispatcherService;
  let paystack: FakePaystackClient;

  const token: Partial<Record<StaffRole, string>> = {};
  const staffId: Partial<Record<StaffRole, string>> = {};

  let food: { id: string; slug: string; name: string; priceKobo: number };
  let drink: { id: string; slug: string; name: string; priceKobo: number };
  let drinkStockId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    dispatcher = app.get(WebhookDispatcherService, { strict: false });
    paystack = fakePaystack(app);

    await seedData(prisma);
    fakeDateOnly(nextNoonInJos());

    // One manager makes every correction below, many times the ₦150,000
    // Daily Approval Limit in all; the ledger still records them (D36).
    // The daily-limit case switches it back on for a manager of its own.
    await prisma.settings.update({
      where: { singleton: true },
      data: { dailyLimitOn: false },
    });

    const tokens = app.get(CncTokenService, { strict: false });

    for (const role of [
      StaffRole.OWNER,
      StaffRole.MANAGER,
      StaffRole.CASHIER,
      StaffRole.WAITER,
    ]) {
      const account = await createStaffAccount(prisma, role);

      staffId[role] = account.id;
      token[role] = await accessTokenFor(tokens, account.id);
    }

    const online = { active: true, showOnline: true };

    food = await prisma.menuItem.findFirstOrThrow({
      where: {
        ...online,
        department: Department.RESTAURANT,
        choiceOptions: { isEmpty: true },
        priceKobo: { gt: 0 },
      },
      orderBy: { slug: 'asc' },
    });
    drink = await prisma.menuItem.findFirstOrThrow({
      where: {
        ...online,
        department: Department.BAR,
        choiceOptions: { isEmpty: true },
        priceKobo: { gt: 0 },
      },
      orderBy: { slug: 'asc' },
    });
    drinkStockId = (
      await prisma.stockItem.findFirstOrThrow({
        where: { menuItemId: drink.id },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    jest.useRealTimers();
    await dispatcher?.settled();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const auth = (role: StaffRole) => ({
    Authorization: `Bearer ${token[role]!}`,
  });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  const vat = (subtotal: number) => Math.round((subtotal * 750) / 10000);
  /** A bill of `foodQty` dishes and `drinkQty` drinks: lines plus VAT. */
  const bill = (foodQty: number, drinkQty: number) => {
    const subtotal = food.priceKobo * foodQty + drink.priceKobo * drinkQty;

    return subtotal + vat(subtotal);
  };

  const address = {
    zone: 'JOS',
    street: '12 Rayfield Road',
    area: 'Rayfield',
    town: 'Jos',
    landmark: 'Opposite the filling station',
  };

  /** A web order of 2 dishes and 3 drinks for delivery in Jos, paid. */
  const place = async (over: Record<string, unknown> = {}) => {
    const created = (
      await request(server())
        .post('/api/v1/checkouts')
        .set('Idempotency-Key', randomUUID())
        .send({
          lines: [
            { dishId: food.slug, qty: 2 },
            { dishId: drink.slug, qty: 3 },
          ],
          fulfilment: 'DELIVERY',
          address,
          timing: 'ASAP',
          name: 'Ada Okafor',
          phone: '0803 123 4567',
          email: `ada-${randomUUID()}@example.com`,
          note: 'Ring twice',
          ...over,
        })
        .expect(201)
    ).body as { reference: string; sums: { totalKobo: number } };

    await postSignedWebhook(
      app,
      chargeSuccessBody(created.reference, created.sums.totalKobo),
      PAYSTACK_KEY,
    ).expect(200);
    await dispatcher.settled();

    const row = await prisma.onlineOrder.findUniqueOrThrow({
      where: { paystackReference: created.reference },
    });

    return {
      id: row.id,
      reference: created.reference,
      totalKobo: created.sums.totalKobo,
    };
  };

  const read = async (id: string, role: StaffRole = StaffRole.MANAGER) =>
    (
      await request(server())
        .get(`/api/v1/staff/online-orders/${id}`)
        .set(auth(role))
        .expect(200)
    ).body as Detail;

  const command = (
    id: string,
    name: string,
    role: StaffRole,
    body: Record<string, unknown>,
    key?: string,
  ) => {
    const call = request(server())
      .post(`/api/v1/staff/online-orders/${id}/${name}`)
      .set(auth(role));

    return (key ? call.set('Idempotency-Key', key) : call).send(body);
  };

  /**
   * A command on the order's current version, read first:
   * `await run(…).expect(200)`.
   */
  const run = (
    id: string,
    name: string,
    role: StaffRole,
    body: Record<string, unknown>,
    key?: string,
  ) => ({
    expect: async (status: number) => {
      const { version } = await read(id);

      return command(id, name, role, { version, ...body }, key).expect(status);
    },
  });

  const barBalance = async () =>
    (
      await prisma.stockBalance.findUnique({
        where: {
          stockItemId_location: {
            stockItemId: drinkStockId,
            location: StockLocation.BAR,
          },
        },
      })
    )?.qty ?? 0;

  const ledgerRows = (role: StaffRole, action: string) =>
    prisma.approvalLedger.findMany({
      where: { staffId: staffId[role], action },
      orderBy: { createdAt: 'asc' },
    });

  describe('the reads', () => {
    it('lists a paid order under Active for the Cashier, and refuses a Waiter', async () => {
      const placed = await place();
      const page = (
        await request(server())
          .get('/api/v1/staff/online-orders')
          .set(auth(StaffRole.CASHIER))
          .expect(200)
      ).body as {
        data: { id: string; balanceKobo: number; totalKobo: number }[];
        total: number;
      };

      expect(page.data.map((row) => row.id)).toContain(placed.id);
      expect(page.data.find((row) => row.id === placed.id)).toMatchObject({
        totalKobo: placed.totalKobo,
        balanceKobo: 0,
      });

      const history = (
        await request(server())
          .get('/api/v1/staff/online-orders?tab=HISTORY')
          .set(auth(StaffRole.CASHIER))
          .expect(200)
      ).body as { data: { id: string }[] };

      expect(history.data.map((row) => row.id)).not.toContain(placed.id);

      const detail = await read(placed.id, StaffRole.CASHIER);

      expect(detail).toMatchObject({
        fulfilmentStatus: OnlineFulfilmentStatus.RECEIVED,
        mode: 'WITHIN_JOS',
        contactName: 'Ada Okafor',
        note: 'Ring twice',
        address: {
          street: address.street,
          area: address.area,
          town: address.town,
          landmark: address.landmark,
        },
        money: {
          billTotalKobo: bill(2, 3),
          feeKobo: 500000,
          totalKobo: placed.totalKobo,
          paidKobo: placed.totalKobo,
          balanceKobo: 0,
          cardRefundableKobo: placed.totalKobo,
        },
      });

      const waiter = await request(server())
        .get(`/api/v1/staff/online-orders/${placed.id}`)
        .set(auth(StaffRole.WAITER))
        .expect(403);

      expect(messageOf(waiter)).toBe(ROLE_REFUSED_MESSAGE);

      const missing = await request(server())
        .get('/api/v1/staff/online-orders/no-such-order')
        .set(auth(StaffRole.CASHIER))
        .expect(404);

      expect(messageOf(missing)).toBe(ONLINE_ORDER_NOT_FOUND_MESSAGE);
    });
  });

  describe('online.status and online.correctStatus', () => {
    it('lets the Cashier move one stage at a time to Delivered (gate step 3)', async () => {
      const { id } = await place();
      const skip = await run(id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.DELIVERED,
      }).expect(409);

      expect(messageOf(skip)).toBe(NEXT_STAGE_MESSAGE);

      const wrongMode = await run(id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.PREPARING,
      })
        .expect(200)
        .then(() =>
          run(id, 'status', StaffRole.CASHIER, {
            status: OnlineFulfilmentStatus.READY,
          }).expect(409),
        );

      expect(messageOf(wrongMode)).toBe(NEXT_STAGE_MESSAGE);

      for (const status of [
        OnlineFulfilmentStatus.ON_THE_WAY,
        OnlineFulfilmentStatus.DELIVERED,
      ]) {
        const moved = (
          await run(id, 'status', StaffRole.CASHIER, { status }).expect(200)
        ).body as Detail;

        expect(moved.fulfilmentStatus).toBe(status);
      }

      const closed = await run(id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.DELIVERED,
      }).expect(409);

      expect(messageOf(closed)).toBe(ONLINE_ORDER_CLOSED_MESSAGE);

      const history = (
        await request(server())
          .get('/api/v1/staff/online-orders?tab=HISTORY')
          .set(auth(StaffRole.CASHIER))
          .expect(200)
      ).body as { data: { id: string }[] };

      expect(history.data.map((row) => row.id)).toContain(id);

      const order = await prisma.onlineOrder.findUniqueOrThrow({
        where: { id },
        include: { order: true },
      });
      const audits = await prisma.auditLog.findMany({
        where: { ref: order.order.number, action: 'online.status' },
      });

      expect(audits).toHaveLength(3);
    });

    it('refuses a stale version', async () => {
      const { id } = await place();
      const { version } = await read(id);

      await command(id, 'status', StaffRole.CASHIER, {
        version,
        status: OnlineFulfilmentStatus.PREPARING,
      }).expect(200);

      const stale = await command(id, 'status', StaffRole.CASHIER, {
        version,
        status: OnlineFulfilmentStatus.ON_THE_WAY,
      }).expect(409);

      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);
    });

    it('lets a manager correct the stage backwards with a reason, never across modes', async () => {
      const { id } = await place();

      const cashier = await run(id, 'correct-status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.DELIVERED,
        reason: 'Delivered already',
      }).expect(403);

      expect(messageOf(cashier)).toBe(ROLE_REFUSED_MESSAGE);

      const noReason = await run(id, 'correct-status', StaffRole.MANAGER, {
        status: OnlineFulfilmentStatus.DELIVERED,
      }).expect(400);

      expect(messageOf(noReason)).toEqual([ADMIN_REASON_MESSAGE]);

      const invalid = await run(id, 'correct-status', StaffRole.MANAGER, {
        status: 'CANCELLED',
        reason: 'Wrong',
      }).expect(400);

      expect(messageOf(invalid)).toEqual([INVALID_FULFILMENT_STATUS_MESSAGE]);

      const mismatch = await run(id, 'correct-status', StaffRole.MANAGER, {
        status: OnlineFulfilmentStatus.READY,
        reason: 'Wrong',
      }).expect(400);

      expect(messageOf(mismatch)).toBe(STATUS_MODE_MESSAGE);

      await run(id, 'correct-status', StaffRole.MANAGER, {
        status: OnlineFulfilmentStatus.DELIVERED,
        reason: 'Delivered already',
      }).expect(200);

      const back = (
        await run(id, 'correct-status', StaffRole.MANAGER, {
          status: OnlineFulfilmentStatus.PREPARING,
          reason: 'Correct mistaken close',
        }).expect(200)
      ).body as Detail;

      expect(back.fulfilmentStatus).toBe(OnlineFulfilmentStatus.PREPARING);
    });
  });

  describe('online.edit and online.balance (gate step 4)', () => {
    it('edits a paid order down, moves the Bar, refunds through Paystack once, then completes', async () => {
      const placed = await place();
      const barBefore = await barBalance();
      const refundsBefore = paystack.refunds.length;

      const cashier = await run(placed.id, 'edit', StaffRole.CASHIER, {
        lines: [{ menuItemId: food.id, qty: 1 }],
        reason: 'Guest called',
      }).expect(403);

      expect(messageOf(cashier)).toBe(ROLE_REFUSED_MESSAGE);

      const edited = (
        await run(placed.id, 'edit', StaffRole.MANAGER, {
          lines: [
            { menuItemId: food.id, qty: 1 },
            { menuItemId: drink.id, qty: 1 },
          ],
          note: 'No pepper',
          reason: 'Guest called',
        }).expect(200)
      ).body as Change;
      const refundKobo = bill(2, 3) - bill(1, 1);

      expect(edited.onlineOrder.money).toMatchObject({
        totalKobo: placed.totalKobo - refundKobo,
        paidKobo: placed.totalKobo,
        balanceKobo: -refundKobo,
      });
      expect(edited.onlineOrder.adjustments).toEqual([
        expect.objectContaining({
          action: 'online.edit',
          amountKobo: -refundKobo,
          settled: false,
        }),
      ]);

      // The kitchen: revision 2, the food only, still a delivery.
      expect(edited.docket).toMatchObject({
        revision: 2,
        fulfilment: 'DELIVERY',
        cancellation: false,
        items: [expect.objectContaining({ menuItemId: food.id, qty: 1 })],
      });

      // The Bar: two drinks came back, by one movement.
      expect(await barBalance()).toBe(barBefore + 2);
      expect(
        await prisma.stockMovement.findMany({
          where: {
            ref: edited.onlineOrder.orderNumber,
            type: StockMovementType.WEB_SALE_RETURN,
          },
          select: { qty: true },
        }),
      ).toEqual([{ qty: 2 }]);

      // The edit is counted toward the manager's day by its size.
      expect(
        (await ledgerRows(StaffRole.MANAGER, 'online.edit')).at(-1)?.amountKobo,
      ).toBe(refundKobo);

      // Nobody completes an order that is owed a refund.
      await run(placed.id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.PREPARING,
      }).expect(200);
      await run(placed.id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.ON_THE_WAY,
      }).expect(200);

      const early = await run(placed.id, 'status', StaffRole.CASHIER, {
        status: OnlineFulfilmentStatus.DELIVERED,
      }).expect(409);

      expect(messageOf(early)).toBe(OUTSTANDING_BALANCE_MESSAGE);

      // The refund goes back to the card, through Paystack, once.
      const key = randomUUID();
      const noKey = await run(placed.id, 'balance', StaffRole.MANAGER, {
        method: 'PAYSTACK',
        reason: 'Refund the drinks',
      }).expect(400);

      expect(messageOf(noKey)).toBe(IDEMPOTENCY_KEY_REQUIRED);

      const { version } = await read(placed.id);
      const body = { version, method: 'PAYSTACK', reason: 'Refund the drinks' };
      const refunded = (
        await command(
          placed.id,
          'balance',
          StaffRole.MANAGER,
          body,
          key,
        ).expect(200)
      ).body as Detail;

      expect(paystack.refunds.slice(refundsBefore)).toEqual([
        expect.objectContaining({
          transactionReference: placed.reference,
          amountKobo: refundKobo,
        }),
      ]);
      expect(refunded.money).toMatchObject({
        paidKobo: placed.totalKobo - refundKobo,
        balanceKobo: 0,
        cardRefundableKobo: placed.totalKobo - refundKobo,
      });
      expect(refunded.refunds).toEqual([
        expect.objectContaining({
          amountKobo: refundKobo,
          status: OnlineRefundStatus.SENT,
        }),
      ]);
      expect(refunded.adjustments).toEqual([
        expect.objectContaining({ settled: true }),
      ]);

      const payment = await prisma.payment.findFirstOrThrow({
        where: { orderId: refunded.orderId, amountKobo: { lt: 0 } },
      });

      expect(payment).toMatchObject({
        method: PaymentMethod.ONLINE,
        amountKobo: -refundKobo,
        reversed: false,
        staffId: staffId[StaffRole.MANAGER],
      });
      expect(payment.providerRef).toMatch(
        new RegExp(`^${REFUND_PROVIDER_REF_PREFIX}\\d+$`),
      );

      // A retry with the same key replays; Paystack is not asked again.
      await command(placed.id, 'balance', StaffRole.MANAGER, body, key).expect(
        200,
      );
      expect(paystack.refunds).toHaveLength(refundsBefore + 1);

      const reused = await command(
        placed.id,
        'balance',
        StaffRole.MANAGER,
        { ...body, method: 'CASH' },
        key,
      ).expect(409);

      expect(messageOf(reused)).toBe(IDEMPOTENCY_KEY_REUSED);

      const nothing = await run(
        placed.id,
        'balance',
        StaffRole.MANAGER,
        { method: 'CASH', reason: 'Again' },
        randomUUID(),
      ).expect(409);

      expect(messageOf(nothing)).toBe(NO_ADJUSTMENT_MESSAGE);

      const done = (
        await run(placed.id, 'status', StaffRole.CASHIER, {
          status: OnlineFulfilmentStatus.DELIVERED,
        }).expect(200)
      ).body as Detail;

      expect(done.fulfilmentStatus).toBe(OnlineFulfilmentStatus.DELIVERED);

      // Q8: nothing is edited or cancelled after Completed.
      const late = await run(placed.id, 'cancel', StaffRole.MANAGER, {
        reason: 'Too late',
      }).expect(409);

      expect(messageOf(late)).toBe(SELECT_ACTIVE_ONLINE_ORDER_MESSAGE);

      const audits = await prisma.auditLog.findMany({
        where: { ref: refunded.orderNumber },
        select: { action: true },
        orderBy: { at: 'asc' },
      });

      expect(audits.map((row) => row.action)).toEqual(
        expect.arrayContaining([
          'online.paid',
          'online.edit',
          'online.balance',
          'online.refund',
        ]),
      );
    });

    it('refunds once when two devices settle the same version at once', async () => {
      const { id } = await place();

      await run(id, 'edit', StaffRole.MANAGER, {
        lines: [{ menuItemId: food.id, qty: 2 }],
        reason: 'No drinks',
      }).expect(200);

      const before = paystack.refunds.length;
      const { version } = await read(id);
      const settle = (role: StaffRole) =>
        command(
          id,
          'balance',
          role,
          { version, method: 'PAYSTACK', reason: 'Refund drinks' },
          randomUUID(),
        );
      const answers = await Promise.all([
        settle(StaffRole.MANAGER),
        settle(StaffRole.OWNER),
      ]);

      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
      expect(messageOf(answers.find((answer) => answer.status === 409)!)).toBe(
        STALE_VERSION_MESSAGE,
      );
      expect(paystack.refunds).toHaveLength(before + 1);
      expect((await read(id)).refunds).toHaveLength(1);
    });

    it('takes extra money as Cash or Transfer only (Q34)', async () => {
      const { id } = await place();
      const up = (
        await run(id, 'edit', StaffRole.MANAGER, {
          lines: [
            { menuItemId: food.id, qty: 3 },
            { menuItemId: drink.id, qty: 3 },
          ],
          reason: 'Guest added a dish',
        }).expect(200)
      ).body as Change;
      const extraKobo = bill(3, 3) - bill(2, 3);

      expect(up.onlineOrder.money.balanceKobo).toBe(extraKobo);

      const card = await run(
        id,
        'balance',
        StaffRole.MANAGER,
        { method: 'PAYSTACK', reason: 'Extra dish' },
        randomUUID(),
      ).expect(400);

      expect(messageOf(card)).toBe(EXTRA_MONEY_METHOD_MESSAGE);

      const transfer = await run(
        id,
        'balance',
        StaffRole.MANAGER,
        { method: 'TRANSFER', sender: 'Ada Okafor', reason: 'Extra dish' },
        randomUUID(),
      ).expect(400);

      expect(messageOf(transfer)).toBe(BALANCE_TRANSFER_MESSAGE);

      const paid = (
        await run(
          id,
          'balance',
          StaffRole.MANAGER,
          {
            method: 'TRANSFER',
            sender: 'Ada Okafor',
            reference: 'TRF-123',
            reason: 'Extra dish',
          },
          randomUUID(),
        ).expect(200)
      ).body as Detail;

      expect(paid.money.balanceKobo).toBe(0);
      expect(paid.order.payments.at(-1)).toMatchObject({
        method: PaymentMethod.TRANSFER,
        amountKobo: extraKobo,
      });

      // The demo's order of sentences: the order, then something owed,
      // before the transfer's details.
      const blank = { method: 'TRANSFER', reason: 'Again' };

      expect(
        messageOf(
          await run(
            id,
            'balance',
            StaffRole.MANAGER,
            blank,
            randomUUID(),
          ).expect(409),
        ),
      ).toBe(NO_ADJUSTMENT_MESSAGE);
      expect(
        messageOf(
          await command(
            'no-such-order',
            'balance',
            StaffRole.MANAGER,
            { version: 0, ...blank },
            randomUUID(),
          ).expect(404),
        ),
      ).toBe(ONLINE_ORDER_NOT_FOUND_MESSAGE);
    });

    it('keeps a refused refund owed, and never resends one Paystack did not answer', async () => {
      const refused = await place();

      await run(refused.id, 'edit', StaffRole.MANAGER, {
        lines: [{ menuItemId: food.id, qty: 2 }],
        reason: 'No drinks',
      }).expect(200);

      const owed = bill(2, 3) - bill(2, 0);
      const before = paystack.refunds.length;
      const key = randomUUID();
      const { version } = await read(refused.id);
      const body = { version, method: 'PAYSTACK', reason: 'Refund drinks' };

      paystack.failNextRefundWith = new PaystackRefusedError(400, 'Declined');

      const no = await command(
        refused.id,
        'balance',
        StaffRole.MANAGER,
        body,
        key,
      ).expect(502);

      expect(messageOf(no)).toBe(REFUND_REFUSED_MESSAGE);

      const after = await read(refused.id);

      expect(after.money.balanceKobo).toBe(-owed);
      expect(after.refunds).toEqual([
        expect.objectContaining({ status: OnlineRefundStatus.REFUSED }),
      ]);
      expect(after.order.payments.at(-1)).toMatchObject({
        amountKobo: -owed,
        reversed: true,
      });
      expect(after.adjustments).toEqual([
        expect.objectContaining({ settled: false }),
      ]);

      // The same key replays the refusal and asks Paystack nothing.
      await command(refused.id, 'balance', StaffRole.MANAGER, body, key).expect(
        502,
      );
      expect(paystack.refunds).toHaveLength(before);

      // Q26: a manual refund stays available.
      const cash = (
        await run(
          refused.id,
          'balance',
          StaffRole.MANAGER,
          { method: 'CASH', reason: 'Refunded in cash' },
          randomUUID(),
        ).expect(200)
      ).body as Detail;

      expect(cash.money.balanceKobo).toBe(0);

      // No answer from Paystack: kept, never sent twice.
      const unconfirmed = await place();

      await run(unconfirmed.id, 'edit', StaffRole.MANAGER, {
        lines: [{ menuItemId: food.id, qty: 2 }],
        reason: 'No drinks',
      }).expect(200);

      const key2 = randomUUID();
      const read2 = await read(unconfirmed.id);
      const body2 = {
        version: read2.version,
        method: 'PAYSTACK',
        reason: 'Refund drinks',
      };

      paystack.failNextRefundWith = new PaystackUnavailableError();

      const lost = await command(
        unconfirmed.id,
        'balance',
        StaffRole.MANAGER,
        body2,
        key2,
      ).expect(503);

      expect(messageOf(lost)).toBe(REFUND_UNCONFIRMED_MESSAGE);

      const kept = await read(unconfirmed.id);

      expect(kept.money.balanceKobo).toBe(0);
      expect(kept.refunds).toEqual([
        expect.objectContaining({ status: OnlineRefundStatus.UNCONFIRMED }),
      ]);

      await command(
        unconfirmed.id,
        'balance',
        StaffRole.MANAGER,
        body2,
        key2,
      ).expect(503);
      expect(paystack.refunds).toHaveLength(before);

      // The dashboard shows no refund: a manager records that, and the
      // money is owed again, for Cash.
      const refundId = kept.refunds[0].id;
      const resolve = (body: Record<string, unknown>) =>
        run(
          unconfirmed.id,
          `refunds/${refundId}/resolve`,
          StaffRole.MANAGER,
          body,
        );

      expect(
        messageOf(
          await resolve({
            outcome: 'SENT',
            reason: 'In the dashboard',
          }).expect(400),
        ),
      ).toBe(REFUND_ID_MESSAGE);
      await run(
        unconfirmed.id,
        `refunds/${refundId}/resolve`,
        StaffRole.CASHIER,
        { outcome: 'NOT_SENT', reason: 'Not there' },
      ).expect(403);

      const reopened = (
        await resolve({
          outcome: 'NOT_SENT',
          reason: 'Not in the Paystack dashboard',
        }).expect(200)
      ).body as Detail;

      expect(reopened.money.balanceKobo).toBe(-owed);
      expect(reopened.refunds).toEqual([
        expect.objectContaining({ status: OnlineRefundStatus.REFUSED }),
      ]);
      expect(reopened.adjustments).toEqual([
        expect.objectContaining({ settled: false }),
      ]);
      expect(
        messageOf(
          await resolve({ outcome: 'NOT_SENT', reason: 'Again' }).expect(409),
        ),
      ).toBe(REFUND_NOT_UNCONFIRMED_MESSAGE);
      expect(
        await prisma.auditLog.count({
          where: { action: 'online.resolveRefund' },
        }),
      ).toBe(1);

      const settled = (
        await run(
          unconfirmed.id,
          'balance',
          StaffRole.MANAGER,
          { method: 'CASH', reason: 'Refunded in cash' },
          randomUUID(),
        ).expect(200)
      ).body as Detail;

      expect(settled.money.balanceKobo).toBe(0);
    });

    it('resolves an unconfirmed refund the dashboard shows as sent', async () => {
      const placed = await place();

      await run(placed.id, 'edit', StaffRole.MANAGER, {
        lines: [{ menuItemId: food.id, qty: 2 }],
        reason: 'No drinks',
      }).expect(200);
      paystack.failNextRefundWith = new PaystackUnavailableError();
      await run(
        placed.id,
        'balance',
        StaffRole.MANAGER,
        { method: 'PAYSTACK', reason: 'Refund drinks' },
        randomUUID(),
      ).expect(503);

      const refundId = (await read(placed.id)).refunds[0].id;
      const sent = (
        await run(placed.id, `refunds/${refundId}/resolve`, StaffRole.MANAGER, {
          outcome: 'SENT',
          providerRefundId: '987654',
          reason: 'Shown as processed',
        }).expect(200)
      ).body as Detail;

      expect(sent.money.balanceKobo).toBe(0);
      expect(sent.refunds).toEqual([
        expect.objectContaining({
          status: OnlineRefundStatus.SENT,
          providerRefundId: '987654',
        }),
      ]);
      expect(sent.order.payments.at(-1)).toMatchObject({ reversed: false });
    });
  });

  describe('online.zone (Q27)', () => {
    it('recomputes the fee from the fees the order snapshotted, and clears the address for pickup', async () => {
      const { id } = await place();
      const settings = await prisma.settings.findUniqueOrThrow({
        where: { singleton: true },
      });

      // A fee changed after the order was paid does not reach it.
      await prisma.settings.update({
        where: { singleton: true },
        data: { deliveryOutsideKobo: settings.deliveryOutsideKobo + 200000 },
      });

      try {
        const outside = (
          await run(id, 'zone', StaffRole.MANAGER, {
            mode: 'OUTSIDE_JOS',
            reason: 'Guest is in Bukuru',
          }).expect(200)
        ).body as Change;

        expect(outside.onlineOrder).toMatchObject({
          mode: 'OUTSIDE_JOS',
          money: {
            feeKobo: settings.deliveryOutsideKobo,
            balanceKobo: settings.deliveryOutsideKobo - 500000,
          },
        });
        expect(outside.docket).toBeNull();

        await run(
          id,
          'balance',
          StaffRole.MANAGER,
          { method: 'CASH', reason: 'Rider collected the difference' },
          randomUUID(),
        ).expect(200);

        const pickup = (
          await run(id, 'zone', StaffRole.MANAGER, {
            mode: 'PICKUP',
            reason: 'Guest will collect',
          }).expect(200)
        ).body as Change;

        expect(pickup.onlineOrder).toMatchObject({
          mode: 'PICKUP',
          address: null,
          addressText: '',
          money: { feeKobo: 0, balanceKobo: -settings.deliveryOutsideKobo },
        });
        expect(pickup.docket).toMatchObject({
          revision: 2,
          fulfilment: 'PICKUP',
        });

        await run(id, 'status', StaffRole.CASHIER, {
          status: OnlineFulfilmentStatus.PREPARING,
        }).expect(200);
        await run(id, 'status', StaffRole.CASHIER, {
          status: OnlineFulfilmentStatus.READY,
        }).expect(200);

        const dispatched = await run(id, 'zone', StaffRole.MANAGER, {
          mode: 'WITHIN_JOS',
          address: {
            street: '1 Ahmadu Bello Way',
            area: 'Township',
            town: 'Jos',
            landmark: 'By the stadium',
          },
          reason: 'Changed again',
        }).expect(409);

        expect(messageOf(dispatched)).toBe(ZONE_BEFORE_DISPATCH_MESSAGE);
      } finally {
        await prisma.settings.update({
          where: { singleton: true },
          data: { deliveryOutsideKobo: settings.deliveryOutsideKobo },
        });
      }
    });
  });

  describe('online.cancel (Q8)', () => {
    it('cancels, returns the drinks and sends the kitchen a cancellation docket; the refund goes to the card', async () => {
      const placed = await place();
      const barBefore = await barBalance();

      const cashier = await run(placed.id, 'cancel', StaffRole.CASHIER, {
        reason: 'Guest cancelled',
      }).expect(403);

      expect(messageOf(cashier)).toBe(ROLE_REFUSED_MESSAGE);

      const cancelled = (
        await run(placed.id, 'cancel', StaffRole.MANAGER, {
          reason: 'Guest cancelled',
        }).expect(200)
      ).body as Change;

      expect(cancelled.onlineOrder).toMatchObject({
        fulfilmentStatus: OnlineFulfilmentStatus.CANCELLED,
        order: { status: OrderStatus.CANCELLED },
        money: {
          totalKobo: 0,
          balanceKobo: -placed.totalKobo,
        },
      });
      expect(cancelled.docket).toMatchObject({
        revision: 2,
        items: [],
        cancellation: true,
      });
      expect(await barBalance()).toBe(barBefore + 3);

      const correct = await run(
        placed.id,
        'correct-status',
        StaffRole.MANAGER,
        {
          status: OnlineFulfilmentStatus.PREPARING,
          reason: 'Undo',
        },
      ).expect(409);

      expect(messageOf(correct)).toBe(SELECT_ONLINE_ORDER_MESSAGE);

      const refunded = (
        await run(
          placed.id,
          'balance',
          StaffRole.MANAGER,
          { method: 'PAYSTACK', reason: 'Full refund' },
          randomUUID(),
        ).expect(200)
      ).body as Detail;

      expect(refunded.money).toMatchObject({ paidKobo: 0, balanceKobo: 0 });
      expect(paystack.refunds.at(-1)).toMatchObject({
        transactionReference: placed.reference,
        amountKobo: placed.totalKobo,
      });
    });

    it('returns to the Bar only what the sale took, whatever was paired since', async () => {
      // A drink sold while no Bar stock item was paired with it.
      const unpaired = await prisma.menuItem.findFirstOrThrow({
        where: {
          active: true,
          showOnline: true,
          department: Department.BAR,
          choiceOptions: { isEmpty: true },
          priceKobo: { gt: 0 },
          id: { not: drink.id },
        },
        orderBy: { slug: 'desc' },
      });
      const pairedItem = await prisma.stockItem.findFirstOrThrow({
        where: { menuItemId: unpaired.id },
      });

      // A Bar stock item is always paired with something (a CHECK), so the
      // drink is left unpaired by pointing its item at a dish for now.
      await prisma.stockItem.update({
        where: { id: pairedItem.id },
        data: { menuItemId: food.id },
      });

      try {
        const placed = await place({
          lines: [
            { dishId: food.slug, qty: 1 },
            { dishId: unpaired.slug, qty: 2 },
          ],
        });
        const number = (await read(placed.id)).orderNumber;
        const moved = () =>
          prisma.stockMovement.count({ where: { ref: number } });

        expect(await moved()).toBe(0);

        // A manager pairs it afterwards, then the order is cancelled.
        await prisma.stockItem.update({
          where: { id: pairedItem.id },
          data: { menuItemId: unpaired.id },
        });
        await run(placed.id, 'cancel', StaffRole.MANAGER, {
          reason: 'Guest cancelled',
        }).expect(200);

        // Nothing left the Bar for this order, so nothing comes back.
        expect(await moved()).toBe(0);
      } finally {
        await prisma.stockItem.update({
          where: { id: pairedItem.id },
          data: { menuItemId: unpaired.id },
        });
      }
    });

    it('prices a new option of a dish already on the order at today’s price', async () => {
      const choice = await prisma.menuItem.findFirstOrThrow({
        where: {
          active: true,
          showOnline: true,
          department: Department.RESTAURANT,
          priceKobo: { gt: 0 },
          NOT: { choiceOptions: { isEmpty: true } },
        },
        orderBy: { slug: 'asc' },
      });
      const [first, second] = choice.choiceOptions;
      const placed = await place({
        lines: [{ dishId: choice.slug, option: first, qty: 1 }],
      });
      const raised = choice.priceKobo + 100000;

      await prisma.menuItem.update({
        where: { id: choice.id },
        data: { priceKobo: raised },
      });

      try {
        const edited = (
          await run(placed.id, 'edit', StaffRole.MANAGER, {
            lines: [
              { menuItemId: choice.id, option: first, qty: 1 },
              { menuItemId: choice.id, option: second, qty: 1 },
            ],
            reason: 'Guest added another',
          }).expect(200)
        ).body as Change;
        const priceOf = (option: string) =>
          edited.onlineOrder.order.lines.find((line) => line.option === option)
            ?.unitPriceKobo;

        expect(priceOf(first)).toBe(choice.priceKobo);
        expect(priceOf(second)).toBe(raised);
      } finally {
        await prisma.menuItem.update({
          where: { id: choice.id },
          data: { priceKobo: choice.priceKobo },
        });
      }
    });

    it('refunds to the card only what the card paid, and the rest is recorded as Cash', async () => {
      const placed = await place();
      const { id } = placed;

      await run(id, 'zone', StaffRole.MANAGER, {
        mode: 'OUTSIDE_JOS',
        reason: 'Further away',
      }).expect(200);

      const extraKobo = (await read(id)).money.balanceKobo;

      await run(
        id,
        'balance',
        StaffRole.MANAGER,
        { method: 'CASH', reason: 'Extra fee' },
        randomUUID(),
      ).expect(200);
      await run(id, 'cancel', StaffRole.MANAGER, {
        reason: 'Guest cancelled',
      }).expect(200);

      // Owed: the card's money and the cash. Q26: the card's part goes
      // back through Paystack; the rest stays owed.
      const card = (
        await run(
          id,
          'balance',
          StaffRole.MANAGER,
          { method: 'PAYSTACK', reason: 'Full refund' },
          randomUUID(),
        ).expect(200)
      ).body as Detail;

      expect(paystack.refunds.at(-1)).toMatchObject({
        transactionReference: placed.reference,
        amountKobo: placed.totalKobo,
      });
      expect(card.money.balanceKobo).toBe(-extraKobo);
      expect(card.adjustments.some((one) => !one.settled)).toBe(true);

      // Nothing is left on the card to refund.
      const tooMuch = await run(
        id,
        'balance',
        StaffRole.MANAGER,
        { method: 'PAYSTACK', reason: 'The rest' },
        randomUUID(),
      ).expect(409);

      expect(messageOf(tooMuch)).toBe(CARD_REFUND_LIMIT_MESSAGE);

      const cash = (
        await run(
          id,
          'balance',
          StaffRole.MANAGER,
          { method: 'CASH', reason: 'Refunded in cash' },
          randomUUID(),
        ).expect(200)
      ).body as Detail;

      expect(cash.money.balanceKobo).toBe(0);
      expect(cash.adjustments.every((one) => one.settled)).toBe(true);
    });
  });

  describe('the approval limits', () => {
    it('sends a change or a refund above the Owner Approval Limit to the Owner, who is never counted', async () => {
      const { id } = await place();
      const settings = await prisma.settings.findUniqueOrThrow({
        where: { singleton: true },
      });
      const limitKobo = 1000;

      await prisma.settings.update({
        where: { singleton: true },
        data: { approvalLimitKobo: limitKobo },
      });

      try {
        const lines = [{ menuItemId: food.id, qty: 1 }];
        const manager = await run(id, 'edit', StaffRole.MANAGER, {
          lines,
          reason: 'Guest called',
        }).expect(403);

        expect(messageOf(manager)).toBe(
          approvalLimitMessage(LIMITED_DECISIONS.onlineChange, limitKobo),
        );

        await run(id, 'edit', StaffRole.OWNER, {
          lines,
          reason: 'Guest called',
        }).expect(200);

        const refund = await run(
          id,
          'balance',
          StaffRole.MANAGER,
          { method: 'PAYSTACK', reason: 'Refund' },
          randomUUID(),
        ).expect(403);

        expect(messageOf(refund)).toBe(
          approvalLimitMessage(LIMITED_DECISIONS.paymentCorrection, limitKobo),
        );

        await run(
          id,
          'balance',
          StaffRole.OWNER,
          { method: 'PAYSTACK', reason: 'Refund' },
          randomUUID(),
        ).expect(200);

        expect(
          await prisma.approvalLedger.count({
            where: { staffId: staffId[StaffRole.OWNER] },
          }),
        ).toBe(0);
      } finally {
        await prisma.settings.update({
          where: { singleton: true },
          data: { approvalLimitKobo: settings.approvalLimitKobo },
        });
      }
    });

    it('counts each change toward the manager’s Daily Approval Limit', async () => {
      const { id } = await place();
      const tokens = app.get(CncTokenService, { strict: false });
      const account = await createStaffAccount(prisma, StaffRole.MANAGER);
      const dailyToken = await accessTokenFor(tokens, account.id);
      const settings = await prisma.settings.findUniqueOrThrow({
        where: { singleton: true },
      });
      const firstKobo = bill(2, 3) - bill(1, 3);
      const secondKobo = bill(1, 3) - bill(1, 2);

      await prisma.settings.update({
        where: { singleton: true },
        data: {
          approvalLimitKobo: 100_000_000,
          dailyLimitOn: true,
          dailyLimitKobo: firstKobo,
        },
      });

      const edit = (drinks: number, foodQty: number) => ({
        expect: async (status: number) => {
          const { version } = await read(id);

          return request(server())
            .post(`/api/v1/staff/online-orders/${id}/edit`)
            .set({ Authorization: `Bearer ${dailyToken}` })
            .send({
              version,
              lines: [
                { menuItemId: food.id, qty: foodQty },
                { menuItemId: drink.id, qty: drinks },
              ],
              reason: 'Guest called',
            })
            .expect(status);
        },
      });

      try {
        await edit(3, 1).expect(200);

        const second = await edit(2, 1).expect(403);

        expect(messageOf(second)).toBe(
          dailyLimitMessage(firstKobo + secondKobo, firstKobo),
        );
        expect(
          (
            await prisma.approvalLedger.findMany({
              where: { staffId: account.id },
            })
          ).map((row) => row.amountKobo),
        ).toEqual([firstKobo]);
      } finally {
        await prisma.settings.update({
          where: { singleton: true },
          data: {
            approvalLimitKobo: settings.approvalLimitKobo,
            dailyLimitOn: settings.dailyLimitOn,
            dailyLimitKobo: settings.dailyLimitKobo,
          },
        });
      }
    });
  });

  /**
   * C8-0, the founder's decision of 2026-10-24: a card refund Paystack
   * refused, or one a manager resolves as not in the dashboard, gives back
   * what its `online.balance` counted, on that decision's own day; the Cash
   * or Transfer that pays it then counts once. Each case has a manager of
   * its own, so their ledger is the case's alone. The later-day case moves
   * the clock forward and so comes last in the file.
   */
  describe('refused card refunds and the Daily Approval Limit (C8-0)', () => {
    const tokens = () => app.get(CncTokenService, { strict: false });

    /** A manager of the case's own, with a token minted now. */
    const freshManager = async () => {
      const account = await createStaffAccount(prisma, StaffRole.MANAGER);

      return { account, token: await accessTokenFor(tokens(), account.id) };
    };

    /** A command by one person, on the order's current version. */
    const by =
      (bearer: string) =>
      async (
        id: string,
        name: string,
        body: Record<string, unknown>,
        key?: string,
      ) => {
        const { version } = await read(id, StaffRole.OWNER);
        const call = request(server())
          .post(`/api/v1/staff/online-orders/${id}/${name}`)
          .set({ Authorization: `Bearer ${bearer}` });

        return (key ? call.set('Idempotency-Key', key) : call).send({
          version,
          ...body,
        });
      };

    const ledgerOf = (staff: string) =>
      prisma.approvalLedger.findMany({
        where: { staffId: staff },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    const sumOf = (rows: { amountKobo: number }[]) =>
      rows.reduce((sum, row) => sum + row.amountKobo, 0);
    const isoDay = (date: Date) => date.toISOString().slice(0, 10);

    /** A paid order a manager edits down to food only: the drinks owed. */
    const owedOrder = async (bearer: string) => {
      const placed = await place();

      await by(bearer)(placed.id, 'edit', {
        lines: [{ menuItemId: food.id, qty: 2 }],
        reason: 'No drinks',
      }).then((answer) => expect(answer.status).toBe(200));

      return { ...placed, owedKobo: bill(2, 3) - bill(2, 0) };
    };

    it('releases a refused card refund, so the Cash that pays it counts once', async () => {
      const { account, token: bearer } = await freshManager();
      const settings = await prisma.settings.findUniqueOrThrow({
        where: { singleton: true },
      });
      const order = await owedOrder(bearer);
      const owed = order.owedKobo;

      // Room for the edit and one refund, and nothing more.
      await prisma.settings.update({
        where: { singleton: true },
        data: {
          approvalLimitKobo: 100_000_000,
          dailyLimitOn: true,
          dailyLimitKobo: 2 * owed,
        },
      });

      try {
        paystack.failNextRefundWith = new PaystackRefusedError(400, 'Declined');

        const refused = await by(bearer)(
          order.id,
          'balance',
          { method: 'PAYSTACK', reason: 'Refund drinks' },
          randomUUID(),
        );

        expect(refused.status).toBe(502);

        const afterRefusal = await ledgerOf(account.id);
        const counted = afterRefusal.find(
          (row) => row.action === 'online.balance',
        )!;

        expect(afterRefusal.map((row) => [row.action, row.amountKobo])).toEqual(
          [
            ['online.edit', owed],
            ['online.balance', owed],
            [REFUND_RELEASE_ACTION, -owed],
          ],
        );
        expect(afterRefusal.at(-1)).toMatchObject({
          releasesId: counted.id,
          ref: counted.ref,
          businessDate: counted.businessDate,
        });
        expect(
          await app
            .get(MoneyControlService, { strict: false })
            .standing(prisma, account),
        ).toMatchObject({ approvedTodayKobo: owed });

        // Counted twice, the Cash would take the day to 3 × owed and be
        // refused; released, it fits exactly.
        const cash = await by(bearer)(
          order.id,
          'balance',
          { method: 'CASH', reason: 'Refunded in cash' },
          randomUUID(),
        );

        expect(cash.status).toBe(200);
        expect(sumOf(await ledgerOf(account.id))).toBe(2 * owed);
        expect(
          sumOf(
            (await ledgerOf(account.id)).filter(
              (row) => row.action !== 'online.edit',
            ),
          ),
        ).toBe(owed);
      } finally {
        await prisma.settings.update({
          where: { singleton: true },
          data: {
            approvalLimitKobo: settings.approvalLimitKobo,
            dailyLimitOn: settings.dailyLimitOn,
            dailyLimitKobo: settings.dailyLimitKobo,
          },
        });
      }
    });

    it('releases an unconfirmed refund resolved as not sent, on the deciding manager', async () => {
      const { account, token: bearer } = await freshManager();
      const order = await owedOrder(bearer);

      paystack.failNextRefundWith = new PaystackUnavailableError();
      expect(
        (
          await by(bearer)(
            order.id,
            'balance',
            { method: 'PAYSTACK', reason: 'Refund drinks' },
            randomUUID(),
          )
        ).status,
      ).toBe(503);

      // Unconfirmed, it keeps counting.
      expect(sumOf(await ledgerOf(account.id))).toBe(2 * order.owedKobo);

      const refundId = (await read(order.id)).refunds[0].id;

      // Another person (the Owner) resolves it; the release is the
      // deciding manager's, as the count was.
      expect(
        (
          await by(token[StaffRole.OWNER]!)(
            order.id,
            `refunds/${refundId}/resolve`,
            { outcome: 'NOT_SENT', reason: 'Not in the dashboard' },
          )
        ).status,
      ).toBe(200);

      const rows = await ledgerOf(account.id);

      expect(rows.at(-1)).toMatchObject({
        action: REFUND_RELEASE_ACTION,
        amountKobo: -order.owedKobo,
      });
      expect(sumOf(rows)).toBe(order.owedKobo);
      expect(
        await prisma.approvalLedger.count({
          where: { staffId: staffId[StaffRole.OWNER] },
        }),
      ).toBe(0);
    });

    it('keeps counting a refund the dashboard shows as sent', async () => {
      const { account, token: bearer } = await freshManager();
      const order = await owedOrder(bearer);

      paystack.failNextRefundWith = new PaystackUnavailableError();
      await by(bearer)(
        order.id,
        'balance',
        { method: 'PAYSTACK', reason: 'Refund drinks' },
        randomUUID(),
      );

      const refundId = (await read(order.id)).refunds[0].id;

      expect(
        (
          await by(bearer)(order.id, `refunds/${refundId}/resolve`, {
            outcome: 'SENT',
            providerRefundId: '555123',
            reason: 'Shown as processed',
          })
        ).status,
      ).toBe(200);

      const rows = await ledgerOf(account.id);

      expect(rows.map((row) => row.action)).toEqual([
        'online.edit',
        'online.balance',
      ]);
      expect(sumOf(rows)).toBe(2 * order.owedKobo);
    });

    it('releases once when two sends of the same refund meet a refusal', async () => {
      const { account, token: bearer } = await freshManager();
      const order = await owedOrder(bearer);
      const { version } = await read(order.id);
      const online = app.get(OnlineOrdersService, { strict: false });
      const refunds = app.get(OnlineRefundsService, { strict: false });

      // Recorded as the route records it, and not yet sent.
      const recorded = await prisma.$transaction((tx) =>
        online.balance(
          tx,
          account,
          order.id,
          {
            version,
            method: OnlineBalanceMethod.PAYSTACK,
            reason: 'Refund drinks',
          },
          '127.0.0.1',
        ),
      );
      const sentBefore = paystack.refunds.length;

      paystack.failNextRefundWith = new PaystackRefusedError(400, 'Declined');

      const outcomes = await Promise.all([
        refunds.send(recorded.refundId!, account, '127.0.0.1'),
        refunds.send(recorded.refundId!, account, '127.0.0.1'),
      ]);

      expect(outcomes).toContain(OnlineRefundStatus.REFUSED);
      // Had the second reached Paystack, the fake would have taken it.
      expect(paystack.refunds).toHaveLength(sentBefore);

      const rows = await ledgerOf(account.id);

      expect(
        rows.filter((row) => row.action === REFUND_RELEASE_ACTION),
      ).toHaveLength(1);
      expect(sumOf(rows)).toBe(order.owedKobo);
      expect(
        await prisma.auditLog.count({
          where: {
            ref: (await read(order.id)).orderNumber,
            action: 'online.refund',
          },
        }),
      ).toBe(1);
    });

    it('releases on the day the refund was counted when it is resolved a day later', async () => {
      const { account, token: bearer } = await freshManager();
      const order = await owedOrder(bearer);

      paystack.failNextRefundWith = new PaystackUnavailableError();
      await by(bearer)(
        order.id,
        'balance',
        { method: 'PAYSTACK', reason: 'Refund drinks' },
        randomUUID(),
      );

      const countedOn = isoDay(
        (await ledgerOf(account.id)).find(
          (row) => row.action === 'online.balance',
        )!.businessDate,
      );
      const refundId = (await read(order.id)).refunds[0].id;

      // The next day; tokens minted before the jump have expired.
      jest.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);

      const nextDay = await accessTokenFor(tokens(), account.id);

      token[StaffRole.OWNER] = await accessTokenFor(
        tokens(),
        staffId[StaffRole.OWNER]!,
      );
      expect(
        (
          await by(nextDay)(order.id, `refunds/${refundId}/resolve`, {
            outcome: 'NOT_SENT',
            reason: 'Not in the dashboard',
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await by(nextDay)(
            order.id,
            'balance',
            { method: 'CASH', reason: 'Refunded in cash' },
            randomUUID(),
          )
        ).status,
      ).toBe(200);

      const rows = await ledgerOf(account.id);
      const release = rows.find((row) => row.action === REFUND_RELEASE_ACTION)!;
      const cash = rows.at(-1)!;

      expect(isoDay(release.businessDate)).toBe(countedOn);
      expect(release.amountKobo).toBe(-order.owedKobo);
      expect(cash.action).toBe('online.balance');
      expect(isoDay(cash.businessDate)).not.toBe(countedOn);
      // The first day keeps only the edit; the second has the Cash.
      expect(
        sumOf(rows.filter((row) => isoDay(row.businessDate) === countedOn)),
      ).toBe(order.owedKobo);
      expect(
        sumOf(rows.filter((row) => isoDay(row.businessDate) !== countedOn)),
      ).toBe(order.owedKobo);
    });
  });
});
