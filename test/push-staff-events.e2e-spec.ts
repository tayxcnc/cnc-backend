const PAYSTACK_KEY = 'sk_test_cnc_push_staff_e2e_not_a_real_key';

process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  type Prisma,
  PushMessageStatus,
  StaffRole,
  StockKind,
  StockLocation,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { PaystackRefusedError } from '../src/payments/paystack-client';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { PushQueueService } from '../src/push/push-queue.service';
import { createTestApp, pushSender } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import { fakePaystack } from './fake-paystack-client';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { addDevice, fcmPrefix } from './push-devices';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';
import {
  holdWebCheckout,
  openWebCheckout,
  placePaidWebOrder,
  webDish,
} from './web-orders';

const HOUR = 60 * 60 * 1000;

/** The people of this suite, by a short name. */
const PEOPLE = {
  owner: StaffRole.OWNER,
  manager: StaffRole.MANAGER,
  cashierA: StaffRole.CASHIER,
  cashierB: StaffRole.CASHIER,
  kitchen: StaffRole.KITCHEN,
  storekeeper: StaffRole.STOREKEEPER,
  reception: StaffRole.RECEPTION,
  waiter: StaffRole.WAITER,
  bartender: StaffRole.BARTENDER,
} as const;

type Person = keyof typeof PEOPLE;

/**
 * The staff pushes the commands raise (C10, spec §1.2: PS1 to PS3, PS5 to
 * PS10): each event's audience and D8's chain (on duty, else every active
 * holder, else the managers), the actor left out, the four alert switches,
 * the purchase review task's rule, a legitimate repeat pushing again, the
 * low-stock push queued once a Lagos day and sent only by the sweep, D6's
 * off-hours hold (and urgent pushes never held), and the roles that never
 * receive anything.
 *
 * On a database of its own, because the chain reads every account: the
 * people below are the only staff, each with one device. Now is the next
 * noon in Jos; the last part moves the clock to 01:30 the next night.
 */
describe('Staff pushes (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  let dish: { id: string; slug: string };

  const id = {} as Record<Person, string>;
  const token = {} as Record<Person, string>;
  const prefix = {} as Record<Person, string>;
  /** Where the clock starts: the next noon in Jos. */
  const NOON = nextNoonInJos();

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);
    fakeDateOnly(NOON);

    await prisma.settings.update({
      where: { singleton: true },
      data: { dailyLimitOn: false },
    });

    for (const [name, role] of Object.entries(PEOPLE) as [
      Person,
      StaffRole,
    ][]) {
      const account = await createStaffAccount(prisma, role, {
        emailPrefix: `push-staff-${name.toLowerCase()}`,
        name: `Push ${name}`,
      });

      id[name] = account.id;
      token[name] = await accessTokenFor(tokens, account.id);
      prefix[name] = fcmPrefix();
      await addDevice(prisma, { staffId: account.id }, `${prefix[name]}-1`);
    }

    dish = await webDish(prisma);
  }, 120_000);

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const as = (who: Person) => ({ Authorization: `Bearer ${token[who]}` });
  const nameOf = (staffId: string | null) =>
    (Object.keys(id) as Person[]).find((name) => id[name] === staffId);

  /** Who holds a row of these pushes, by name, sorted. */
  const recipients = async (where: Prisma.PushMessageWhereInput) =>
    (
      await prisma.pushMessage.findMany({
        where: { ...where, staffId: { not: null } },
        select: { staffId: true },
      })
    )
      .map(({ staffId }) => nameOf(staffId))
      .sort();

  /** The titles one person's device received, in order. */
  const titles = (who: Person) =>
    pushSender(app)
      .sentTo(prefix[who])
      .map(({ payload }) => payload.title);

  const setAlerts = (
    data: Partial<
      Record<'alertApprovals' | 'alertLowStock' | 'alertArrivals', boolean>
    >,
  ) => prisma.settings.update({ where: { singleton: true }, data });

  // --------------------------------------------------------- web orders

  describe('web orders (PS1, PS2, PS3)', () => {
    it('PS1 goes to the Cashier on duty, else every active Cashier, else the managers; PS2 to the Kitchen; both urgent', async () => {
      const shift = await prisma.attendanceRecord.create({
        data: {
          staffId: id.cashierA,
          businessDate: watToday(new Date()),
          timeIn: new Date(Date.now() - HOUR),
        },
      });

      const first = await placePaidWebOrder(app, PAYSTACK_KEY, dish.slug);

      expect(await recipients({ topic: `online:${first.id}:placed` })).toEqual([
        'cashierA',
      ]);
      expect(
        await recipients({ event: 'docket.web', topic: { endsWith: ':1' } }),
      ).toEqual(['kitchen']);

      const [received] = pushSender(app).sentTo(prefix.cashierA);

      expect(received.payload).toMatchObject({
        title: `New web order ${first.number}`,
        body: 'Pickup, paid online. Open Online Orders.',
        link: '/#online',
        ref: first.id,
        urgent: true,
      });
      expect(received.options.urgency).toBe('high');
      expect(titles('kitchen')).toEqual([
        expect.stringMatching(/^New web docket KOT-CNCR-\d{6,}$/),
      ]);

      // Off duty now: every active Cashier.
      await prisma.attendanceRecord.update({
        where: { id: shift.id },
        data: { timeOut: new Date() },
      });

      const second = await placePaidWebOrder(app, PAYSTACK_KEY, dish.slug);

      expect(await recipients({ topic: `online:${second.id}:placed` })).toEqual(
        ['cashierA', 'cashierB'],
      );

      // No active Cashier: the managers.
      await prisma.staff.updateMany({
        where: { id: { in: [id.cashierA, id.cashierB] } },
        data: { isActive: false },
      });

      try {
        const third = await placePaidWebOrder(app, PAYSTACK_KEY, dish.slug);

        expect(
          await recipients({ topic: `online:${third.id}:placed` }),
        ).toEqual(['manager', 'owner']);
      } finally {
        await prisma.staff.updateMany({
          where: { id: { in: [id.cashierA, id.cashierB] } },
          data: { isActive: true },
        });
      }
    });

    it('PS2 again when a manager’s edit changes the food', async () => {
      const order = await placePaidWebOrder(app, PAYSTACK_KEY, dish.slug);
      const before = titles('kitchen').length;
      const { version } = (
        await request(server())
          .get(`/api/v1/staff/online-orders/${order.id}`)
          .set(as('manager'))
          .expect(200)
      ).body as { version: number };

      await request(server())
        .post(`/api/v1/staff/online-orders/${order.id}/edit`)
        .set(as('manager'))
        .send({
          version,
          lines: [{ menuItemId: dish.id, qty: 3 }],
          reason: 'Customer called for one more',
        })
        .expect(200);

      expect(titles('kitchen').slice(before)).toEqual([
        expect.stringMatching(/^Web docket changed: KOT-CNCR-\d{6,}$/),
      ]);
      expect(pushSender(app).sentTo(prefix.kitchen).at(-1)!.payload.body).toBe(
        `Order ${order.number} was edited. Open Kitchen.`,
      );
    });

    it('PS3 goes to the managers only when a payment is held', async () => {
      const checkoutId = await holdWebCheckout(
        app,
        PAYSTACK_KEY,
        await openWebCheckout(app, dish.slug),
      );

      expect(await recipients({ topic: `attention:${checkoutId}` })).toEqual([
        'manager',
        'owner',
      ]);
      expect(titles('owner')).toContain('A web payment needs attention');
    });

    it('writes no staff push on any refund path, sent or refused (no PS4)', async () => {
      const staffRows = () =>
        prisma.pushMessage.count({ where: { staffId: { not: null } } });
      const order = await placePaidWebOrder(app, PAYSTACK_KEY, dish.slug);
      const run = async (
        command: string,
        body: Record<string, unknown>,
        status: number,
      ) => {
        const { version } = (
          await request(server())
            .get(`/api/v1/staff/online-orders/${order.id}`)
            .set(as('manager'))
            .expect(200)
        ).body as { version: number };

        await request(server())
          .post(`/api/v1/staff/online-orders/${order.id}/${command}`)
          .set(as('manager'))
          .set('Idempotency-Key', randomUUID())
          .send({ version, ...body })
          .expect(status);
      };

      await run('cancel', { reason: 'Kitchen closed early' }, 200);

      const before = await staffRows();

      fakePaystack(app).failNextRefundWith = new PaystackRefusedError(
        400,
        'Declined',
      );
      await run('balance', { method: 'PAYSTACK', reason: 'Cancelled' }, 502);
      await run('balance', { method: 'PAYSTACK', reason: 'Cancelled' }, 200);

      expect(await staffRows()).toBe(before);
    });
  });

  // ---------------------------------------------------- stock and approvals

  let vendorId: string;
  let rice: string;

  const stockItem = async (minimum: number, kitchenQty: number) => {
    const item = await prisma.stockItem.create({
      data: {
        name: `Push rice ${randomUUID().slice(0, 8)}`,
        kind: StockKind.KITCHEN,
        unit: 'portion',
        pack: 'bag',
        factor: 10,
        minimum,
      },
    });

    await prisma.stockBalance.createMany({
      data: [
        { stockItemId: item.id, location: StockLocation.STORE, qty: 5 },
        {
          stockItemId: item.id,
          location: StockLocation.KITCHEN,
          qty: kitchenQty,
        },
      ],
    });

    return item;
  };

  beforeAll(async () => {
    vendorId = (
      await prisma.vendor.create({
        data: { name: 'Push Vendor', phone: '08030000001' },
      })
    ).id;
    rice = (await stockItem(0, 100)).id;
  });

  const raisePurchase = async (who: Person) =>
    (
      await request(server())
        .post('/api/v1/staff/purchases')
        .set(as(who))
        .set('Idempotency-Key', randomUUID())
        .send({
          lines: [{ stockItemId: rice, qty: 1, costKobo: 100_00, vendorId }],
        })
        .expect(201)
    ).body as { id: string; number: string; version: number };

  const purchaseStatus = async (
    who: Person,
    purchaseId: string,
    status: string,
  ) => {
    const { version } = await prisma.purchase.findUniqueOrThrow({
      where: { id: purchaseId },
    });

    await request(server())
      .post(`/api/v1/staff/purchases/${purchaseId}/status`)
      .set(as(who))
      .send({ version, status, reason: 'Push suite' })
      .expect(200);
  };

  const logWaste = async (stockItemId: string, qty: number) =>
    (
      await request(server())
        .post('/api/v1/staff/waste')
        .set(as('kitchen'))
        .set('Idempotency-Key', randomUUID())
        .send({ location: 'KITCHEN', stockItemId, qty, reason: 'SPOILED' })
        .expect(201)
    ).body as { id: string; version: number };

  const wasteCommand = async (
    wasteId: string,
    path: string,
    body: Record<string, unknown> = {},
  ) => {
    const { version } = await prisma.wasteEntry.findUniqueOrThrow({
      where: { id: wasteId },
    });

    await request(server())
      .post(`/api/v1/staff/waste/${wasteId}/${path}`)
      .set(as('manager'))
      .send({ version, ...body })
      .expect(200);
  };

  describe('approvals (PS5, PS6) and tasks (PS9)', () => {
    it('PS5 when a requisition is raised and each time it is put back to Pending, never to the actor; its review task does not push', async () => {
      const purchase = await raisePurchase('storekeeper');
      const mine = { event: 'purchase.awaiting_approval' };

      expect(
        await recipients({
          ...mine,
          topic: { startsWith: `purchase:${purchase.id}:` },
        }),
      ).toEqual(['manager', 'owner']);
      expect(titles('owner')).toContain('Purchase awaiting approval');
      expect(pushSender(app).sentTo(prefix.owner).at(-1)!.payload.body).toBe(
        `${purchase.number} needs your approval. Open Purchasing.`,
      );
      // The review task to the manager repeats the approval: no push.
      expect(await recipients({ event: 'task.assigned' })).toEqual([]);

      for (let round = 0; round < 2; round += 1) {
        await purchaseStatus('manager', purchase.id, 'APPROVED');
        await purchaseStatus('manager', purchase.id, 'PENDING');
      }

      // The create's two, then the owner's alone for each return.
      expect(
        await recipients({
          ...mine,
          topic: { startsWith: `purchase:${purchase.id}:` },
        }),
      ).toEqual(['manager', 'owner', 'owner', 'owner']);

      // Each approval opened a receive task for the Storekeeper: pushed.
      expect(
        (await recipients({ event: 'task.assigned' })).filter(
          (name) => name === 'storekeeper',
        ),
      ).toHaveLength(2);
    });

    it('PS5 and PS6 follow the approvals alert; with it off the review task pushes its manager', async () => {
      await setAlerts({ alertApprovals: false });

      try {
        const before = await recipients({ event: 'task.assigned' });
        const purchase = await raisePurchase('storekeeper');
        const waste = await logWaste(rice, 1);

        expect(
          await recipients({
            topic: { startsWith: `purchase:${purchase.id}:` },
          }),
        ).toEqual([]);
        expect(
          await recipients({ topic: { startsWith: `waste:${waste.id}:` } }),
        ).toEqual([]);
        expect(await recipients({ event: 'task.assigned' })).toEqual(
          [...before, 'manager'].sort(),
        );
      } finally {
        await setAlerts({ alertApprovals: true });
      }
    });

    it('PS6 when waste is logged and again when it is put back to Pending', async () => {
      const waste = await logWaste(rice, 1);

      expect(
        await recipients({ topic: { startsWith: `waste:${waste.id}:` } }),
      ).toEqual(['manager', 'owner']);

      await wasteCommand(waste.id, 'status', {
        status: 'REJECTED',
        reason: 'Push suite',
      });
      await wasteCommand(waste.id, 'status', {
        status: 'PENDING',
        reason: 'Push suite',
      });

      // The manager put it back: only the owner hears of it again.
      expect(
        await recipients({ topic: { startsWith: `waste:${waste.id}:` } }),
      ).toEqual(['manager', 'owner', 'owner']);
    });

    it('PS9 to each assignee, again when a task is handed back, never to the assigner', async () => {
      const create = (assignedToId: string) =>
        request(server())
          .post('/api/v1/staff/tasks')
          .set(as('manager'))
          .set('Idempotency-Key', randomUUID())
          .send({
            title: 'Call Mrs Bello about the generator',
            type: 'GENERAL',
            status: 'OPEN',
            assignedToId,
          })
          .expect(201)
          .then((response) => response.body as { id: string });
      const reassign = async (taskId: string, assignedToId: string) => {
        const { version } = await prisma.task.findUniqueOrThrow({
          where: { id: taskId },
        });

        await request(server())
          .patch(`/api/v1/staff/tasks/${taskId}`)
          .set(as('manager'))
          .send({
            version,
            title: 'Call Mrs Bello about the generator',
            type: 'GENERAL',
            status: 'OPEN',
            assignedToId,
          })
          .expect(200);
      };

      const task = await create(id.kitchen);

      await reassign(task.id, id.cashierA);
      await reassign(task.id, id.kitchen);

      const own = await create(id.manager);

      expect(
        await recipients({ topic: { startsWith: `task:${task.id}:` } }),
      ).toEqual(['cashierA', 'kitchen', 'kitchen']);
      expect(
        await recipients({ topic: { startsWith: `task:${own.id}:` } }),
      ).toEqual([]);

      // Constant words: a task's title names people and vendors.
      const sent = pushSender(app).sentTo(prefix.kitchen).at(-1)!.payload;

      expect(sent).toMatchObject({
        title: 'New task assigned to you',
        body: 'Open Tasks to see it.',
        link: '/#tasks',
      });
    });
  });

  describe('stock (PS7, PS8)', () => {
    it('PS7 goes to the Store when the Kitchen asks for stock', async () => {
      const asked = (
        await request(server())
          .post('/api/v1/staff/stock/requests')
          .set(as('kitchen'))
          .set('Idempotency-Key', randomUUID())
          .send({ location: 'KITCHEN', stockItemId: rice, qty: 2 })
          .expect(201)
      ).body as { id: string };

      expect(await recipients({ topic: `request:${asked.id}` })).toEqual([
        'storekeeper',
      ]);
      expect(
        pushSender(app).sentTo(prefix.storekeeper).at(-1)!.payload,
      ).toMatchObject({
        title: 'New stock request',
        body: 'Kitchen asked for 1 item. Open Inventory.',
        link: '/#inventory',
      });
    });

    it('PS8 is queued when a movement crosses the line, once a Lagos day, and sent only by the push sweep', async () => {
      const item = await stockItem(5, 6);
      const lowRows = () =>
        prisma.pushMessage.findMany({
          where: {
            event: 'stock.low',
            topic: { startsWith: `low:${item.id}:` },
          },
        });

      // 6 to 4 in the Kitchen, under its level of 5: approved waste.
      const first = await logWaste(item.id, 2);

      await wasteCommand(first.id, 'approve');

      const [queued, ...others] = await lowRows();

      expect(others).toEqual([]);
      expect(nameOf(queued.staffId)).toBe('storekeeper');
      expect(queued).toMatchObject({
        status: PushMessageStatus.PENDING,
        attempts: 0,
        title: `Low stock: ${item.name}`,
        body: 'Kitchen is below its minimum.',
      });
      expect(titles('storekeeper')).not.toContain(`Low stock: ${item.name}`);

      // Back above and under again the same day: no second push.
      await prisma.stockBalance.update({
        where: {
          stockItemId_location: {
            stockItemId: item.id,
            location: StockLocation.KITCHEN,
          },
        },
        data: { qty: 6 },
      });
      await wasteCommand((await logWaste(item.id, 2)).id, 'approve');
      expect(await lowRows()).toHaveLength(1);

      await app.get(PushQueueService, { strict: false }).sweep(new Date());
      expect(titles('storekeeper')).toContain(`Low stock: ${item.name}`);
    });

    it('PS8 follows the low-stock alert', async () => {
      const item = await stockItem(5, 6);

      await setAlerts({ alertLowStock: false });

      try {
        await wasteCommand((await logWaste(item.id, 2)).id, 'approve');
      } finally {
        await setAlerts({ alertLowStock: true });
      }

      expect(
        await prisma.pushMessage.count({
          where: { topic: { startsWith: `low:${item.id}:` } },
        }),
      ).toBe(0);
    });
  });

  // --------------------------------------------------------- bookings

  const tableId = async (code: string) =>
    (
      await prisma.diningTable.findFirstOrThrow({
        where: { code, venue: { slug: 'dining' } },
        select: { id: true },
      })
    ).id;

  /** The manager books a table for today at `time`. */
  const bookToday = async (code: string, time: string) =>
    (
      await request(server())
        .post('/api/v1/staff/reservations')
        .set(as('manager'))
        .set('Idempotency-Key', randomUUID())
        .send({
          name: 'Ada Okafor',
          phone: '08031234567',
          email: `push-guest-${randomUUID()}@example.com`,
          tableId: await tableId(code),
          businessDate: formatIsoDate(watToday(new Date())),
          time,
          party: 2,
        })
        .expect(201)
    ).body as { id: string };

  describe('bookings for today (PS10)', () => {
    it('pushes Reception of a booking for today, without the guest’s name, and follows the arrivals alert', async () => {
      const made = await bookToday('B2', '15:00');

      expect(
        await recipients({ topic: { startsWith: `arrival:${made.id}:` } }),
      ).toEqual(['reception']);

      const sent = pushSender(app).sentTo(prefix.reception).at(-1)!.payload;

      expect(sent).toMatchObject({
        title: 'New booking for today',
        body: expect.stringMatching(
          /^2 guests at 15:00, .+\. Open Reception\.$/,
        ) as string,
        link: '/#reception',
      });
      expect(sent.body).not.toContain('Ada');

      await setAlerts({ alertArrivals: false });

      try {
        const silent = await bookToday('B3', '16:00');

        expect(
          await recipients({ topic: { startsWith: `arrival:${silent.id}:` } }),
        ).toEqual([]);
      } finally {
        await setAlerts({ alertArrivals: true });
      }
    });
  });

  // ------------------------------------------------------ off-hours (D6)

  describe('at 01:30 in Jos, nobody clocked in', () => {
    let checkout: { reference: string; totalKobo: number };
    let opensAt: Date;

    beforeAll(async () => {
      // Opened during the day; Paystack reports it at night.
      checkout = await openWebCheckout(app, dish.slug);

      const night = NOON + 13.5 * HOUR;

      jest.setSystemTime(night);
      // The day's 08:00 opening, less the hour's grace.
      opensAt = new Date(night + 5.5 * HOUR);

      for (const name of Object.keys(id) as Person[]) {
        token[name] = await accessTokenFor(tokens, id[name]);
      }
    });

    it('holds Reception’s push for a booking for today until the window opens', async () => {
      const made = await bookToday('B4', '13:00');
      const [held] = await prisma.pushMessage.findMany({
        where: { topic: { startsWith: `arrival:${made.id}:` } },
      });

      expect(nameOf(held.staffId)).toBe('reception');
      expect(held).toMatchObject({
        status: PushMessageStatus.PENDING,
        attempts: 0,
        retryAfter: opensAt,
      });

      const queue = app.get(PushQueueService, { strict: false });

      expect((await queue.sweep(new Date())).held).toBeGreaterThanOrEqual(1);
      expect(
        (await prisma.pushMessage.findUniqueOrThrow({ where: { id: held.id } }))
          .status,
      ).toBe(PushMessageStatus.PENDING);

      await queue.sweep(new Date(opensAt.getTime() + 1_000));
      expect(
        (await prisma.pushMessage.findUniqueOrThrow({ where: { id: held.id } }))
          .status,
      ).toBe(PushMessageStatus.SENT);
    });

    it('never holds an urgent push: a held payment reaches the managers now', async () => {
      const checkoutId = await holdWebCheckout(app, PAYSTACK_KEY, checkout);
      const rows = await prisma.pushMessage.findMany({
        where: { topic: `attention:${checkoutId}` },
      });

      expect(rows.map((row) => nameOf(row.staffId)).sort()).toEqual([
        'manager',
        'owner',
      ]);
      expect(
        rows.every(
          (row) => row.status === PushMessageStatus.SENT && row.urgent,
        ),
      ).toBe(true);
    });
  });

  // Last, over everything above.
  it('never pushes a Waiter or a Bartender', async () => {
    expect(
      await prisma.pushMessage.count({
        where: { staffId: { in: [id.waiter, id.bartender] } },
      }),
    ).toBe(0);
    expect(titles('waiter')).toEqual([]);
    expect(titles('bartender')).toEqual([]);
  });
});
