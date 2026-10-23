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
} from '../src/money-control/money-control.service';
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
  REFUND_REFUSED_MESSAGE,
  REFUND_UNCONFIRMED_MESSAGE,
  SELECT_ACTIVE_ONLINE_ORDER_MESSAGE,
  SELECT_ONLINE_ORDER_MESSAGE,
  STATUS_MODE_MESSAGE,
  ZONE_BEFORE_DISPATCH_MESSAGE,
} from '../src/online-orders/online-order-messages';
import { REFUND_PROVIDER_REF_PREFIX } from '../src/online-orders/online-refunds.service';
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
    lines: { menuItemId: string; qty: number; unitPriceKobo: number }[];
    payments: {
      number: string;
      method: PaymentMethod;
      amountKobo: number;
      reversed: boolean;
    }[];
  };
  adjustments: { action: string; amountKobo: number; settled: boolean }[];
  refunds: { amountKobo: number; status: OnlineRefundStatus }[];
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

    it('never refunds to a card more than the card paid', async () => {
      const { id } = await place();

      await run(id, 'zone', StaffRole.MANAGER, {
        mode: 'OUTSIDE_JOS',
        reason: 'Further away',
      }).expect(200);
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

      const tooMuch = await run(
        id,
        'balance',
        StaffRole.MANAGER,
        { method: 'PAYSTACK', reason: 'Full refund' },
        randomUUID(),
      ).expect(409);

      expect(messageOf(tooMuch)).toBe(CARD_REFUND_LIMIT_MESSAGE);

      await run(
        id,
        'balance',
        StaffRole.MANAGER,
        { method: 'CASH', reason: 'Refunded in cash' },
        randomUUID(),
      ).expect(200);
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
});
