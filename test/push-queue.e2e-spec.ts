const PAYSTACK_KEY = 'sk_test_cnc_push_queue_e2e_not_a_real_key';

process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import {
  PushDropReason,
  PushMessageStatus,
  StaffRole,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { WebhookDispatcherService } from '../src/payments/webhook-dispatcher.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';
import { PUSH_CATALOGUE } from '../src/push/push-catalogue';
import { asId, asOrderNumber } from '../src/push/push-input-types';
import {
  PUSH_DISPATCH_BUDGET_MS,
  PUSH_LEASE_MS,
  PUSH_MAX_ATTEMPTS,
  PUSH_RETRY_BACKOFF_MS,
  PushQueueService,
} from '../src/push/push-queue.service';
import { createTestApp, pushSender } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { addDevice, fcmPrefix } from './push-devices';
import { createStaffAccount } from './staff-fixtures';
import { placePaidWebOrder, webDish } from './web-orders';

/**
 * The push queue (C10, spec §2.4, D1, D3, D11, D12): one row per person per
 * event, written in the event's transaction and never failing it; the
 * claim and its lease; each outcome a push service can give; the backoff
 * and the attempts cap; the off-hours hold's release; the recipient checked
 * again at send.
 *
 * On a database of its own with the real seeds (the isolation tests place
 * paid web orders, and one of them installs a trigger), the clock faked
 * from the next noon in Jos, inside the staff window. Sends go to
 * `RecordingPushSender`, steered per endpoint prefix.
 */
describe('Push queue (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let queue: PushQueueService;
  let dispatcher: WebhookDispatcherService;
  let dishSlug: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    queue = app.get(PushQueueService, { strict: false });
    dispatcher = app.get(WebhookDispatcherService, { strict: false });

    await seedData(prisma);
    fakeDateOnly(nextNoonInJos());
    dishSlug = (await webDish(prisma)).slug;
  }, 120_000);

  afterAll(async () => {
    jest.useRealTimers();
    await dispatcher?.settled();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const sender = () => pushSender(app);

  /** A live customer, and one device under a run-unique prefix. */
  const customerWithDevice = async (devices = 1) => {
    const row = await prisma.customer.create({
      data: {
        memberNo: await drawNumber(prisma, 'customer'),
        name: 'Push Queue',
        email: `push-queue-${randomUUID()}@cnc.test`,
        emailVerifiedAt: new Date(),
      },
    });
    const prefix = fcmPrefix();

    for (let n = 0; n < devices; n += 1) {
      await addDevice(prisma, { customerId: row.id }, `${prefix}-${n}`);
    }

    return { id: row.id, prefix };
  };

  /** A fresh order stage, so each test's topic is its own. */
  const stage = () => ({
    onlineOrderId: asId(randomUUID()),
    orderNumber: asOrderNumber('WEB-000001'),
    version: 1,
  });

  const enqueue = (customerId: string, input = stage()) =>
    prisma.$transaction((tx) =>
      queue.enqueueCustomer(tx, 'order.preparing', customerId, input),
    );

  const rowOf = (topic: string) =>
    prisma.pushMessage.findFirstOrThrow({ where: { topic } });

  it('writes one row for the same event twice, and sends it once', async () => {
    const me = await customerWithDevice();
    const input = stage();

    const first = await enqueue(me.id, input);
    const second = await enqueue(me.id, input);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(await prisma.pushMessage.count({ where: { topic: first! } })).toBe(
      1,
    );

    await queue.dispatchTopics([first]);
    await queue.dispatchTopics([first]);

    const sent = sender().sentTo(me.prefix);

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({
      id: (await rowOf(first!)).id,
      title: 'Order WEB-000001 is being prepared',
      body: 'The kitchen has started on your order.',
      link: '/account#order/WEB-000001',
      ref: null,
      tag: `order:${input.onlineOrderId}`,
      urgent: false,
      renotify: true,
    });
    expect(sent[0].options.urgency).toBe('normal');
    expect((await rowOf(first!)).status).toBe(PushMessageStatus.SENT);
  });

  it('leaves no row when the event’s transaction rolls back', async () => {
    const me = await customerWithDevice();
    const input = stage();
    let topic: string | null = null;

    await expect(
      prisma.$transaction(async (tx) => {
        topic = await queue.enqueueCustomer(
          tx,
          'order.preparing',
          me.id,
          input,
        );
        throw new Error('The event failed after its push was queued.');
      }),
    ).rejects.toThrow('The event failed');

    expect(topic).not.toBeNull();
    expect(
      await prisma.pushMessage.count({ where: { customerId: me.id } }),
    ).toBe(0);
  });

  it('writes no row for someone with no device', async () => {
    const row = await prisma.customer.create({
      data: {
        memberNo: await drawNumber(prisma, 'customer'),
        name: 'No Device',
        email: `push-none-${randomUUID()}@cnc.test`,
      },
    });

    expect(await enqueue(row.id)).toBeNull();
    expect(
      await prisma.pushMessage.count({ where: { customerId: row.id } }),
    ).toBe(0);
  });

  it('forgets a GONE device, and settles SENT when another device took it', async () => {
    const me = await customerWithDevice(2);

    sender().answer(`${me.prefix}-0`, 'GONE');

    const topic = await enqueue(me.id);

    await queue.dispatchTopics([topic]);

    expect(await rowOf(topic!)).toMatchObject({
      status: PushMessageStatus.SENT,
      attempts: 1,
      retryAfter: null,
    });
    const left = await prisma.customerPushSubscription.findMany({
      where: { customerId: me.id },
    });

    expect(left.map(({ endpoint }) => endpoint)).toEqual([`${me.prefix}-1`]);
    expect(left[0].lastSuccessAt).not.toBeNull();
  });

  it('forgets a device subscribed with another key (403, KEY_MISMATCH)', async () => {
    const me = await customerWithDevice();

    sender().answer(me.prefix, 'KEY_MISMATCH');

    const topic = await enqueue(me.id);

    await queue.dispatchTopics([topic]);

    expect(await rowOf(topic!)).toMatchObject({
      status: PushMessageStatus.DROPPED,
      dropReason: PushDropReason.NO_DEVICE,
    });
    expect(
      await prisma.customerPushSubscription.count({
        where: { customerId: me.id },
      }),
    ).toBe(0);
  });

  it('retries a failed send after its backoff, and gives up at the last attempt', async () => {
    const me = await customerWithDevice();

    sender().answer(me.prefix, 'RETRY');

    const topic = await enqueue(me.id);
    const id = (await rowOf(topic!)).id;
    const t0 = Date.now();

    await queue.dispatchTopics([topic]);

    const failed = await rowOf(topic!);

    expect(failed).toMatchObject({
      status: PushMessageStatus.FAILED,
      attempts: 1,
    });
    expect(failed.retryAfter!.getTime()).toBeGreaterThanOrEqual(
      t0 + PUSH_RETRY_BACKOFF_MS[0],
    );

    // Before the backoff: not tried.
    await queue.dispatchOne(id, Date.now() + PUSH_DISPATCH_BUDGET_MS);
    expect((await rowOf(topic!)).attempts).toBe(1);

    // After the first wait, then after the second.
    let now = new Date(failed.retryAfter!.getTime() + 1);

    expect(
      await queue.dispatchOne(id, Date.now() + PUSH_DISPATCH_BUDGET_MS, now),
    ).toBe('failed');

    const second = await rowOf(topic!);

    expect(second.attempts).toBe(2);
    expect(second.retryAfter!.getTime()).toBe(
      now.getTime() + PUSH_RETRY_BACKOFF_MS[1],
    );

    now = new Date(second.retryAfter!.getTime() + 1);
    expect(
      await queue.dispatchOne(id, Date.now() + PUSH_DISPATCH_BUDGET_MS, now),
    ).toBe('dropped');

    const last = await rowOf(topic!);

    expect(last).toMatchObject({
      status: PushMessageStatus.DROPPED,
      dropReason: PushDropReason.GAVE_UP,
      attempts: PUSH_MAX_ATTEMPTS,
      retryAfter: null,
    });
    expect(sender().sentTo(me.prefix)).toHaveLength(PUSH_MAX_ATTEMPTS);
  });

  it('drops a push the push service rejects', async () => {
    const me = await customerWithDevice();

    sender().answer(me.prefix, 'REJECTED');

    const topic = await enqueue(me.id);

    await queue.dispatchTopics([topic]);

    expect(await rowOf(topic!)).toMatchObject({
      status: PushMessageStatus.DROPPED,
      dropReason: PushDropReason.REJECTED,
    });
    // The device itself is kept: the push was refused, not the device.
    expect(
      await prisma.customerPushSubscription.count({
        where: { customerId: me.id },
      }),
    ).toBe(1);
  });

  it('drops a push whose time ran out before it was sent', async () => {
    const me = await customerWithDevice();
    const topic = await enqueue(me.id);
    const row = await rowOf(topic!);

    const result = await queue.sweep(new Date(row.expiresAt.getTime() + 1));

    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await rowOf(topic!)).toMatchObject({
      status: PushMessageStatus.DROPPED,
      dropReason: PushDropReason.EXPIRED,
      attempts: 0,
    });
    expect(sender().sentTo(me.prefix)).toHaveLength(0);
  });

  it('leaves a push PENDING with no attempt spent while the sender skips', async () => {
    const me = await customerWithDevice();

    sender().answer(me.prefix, 'SKIPPED');

    const topic = await enqueue(me.id);

    await queue.dispatchTopics([topic]);

    expect(await rowOf(topic!)).toMatchObject({
      status: PushMessageStatus.PENDING,
      attempts: 0,
      retryAfter: null,
    });

    // Delivered once the sender works.
    sender().answer(me.prefix, 'SENT');
    await queue.dispatchTopics([topic]);
    expect((await rowOf(topic!)).status).toBe(PushMessageStatus.SENT);
  });

  it('sends once when two dispatches race for the same push', async () => {
    const me = await customerWithDevice();
    const topic = await enqueue(me.id);
    const { id } = await rowOf(topic!);
    const deadline = Date.now() + PUSH_DISPATCH_BUDGET_MS;

    const outcomes = await Promise.all([
      queue.dispatchOne(id, deadline),
      queue.dispatchOne(id, deadline),
    ]);

    expect(outcomes.sort()).toEqual(['sent', 'skipped']);
    expect(sender().sentTo(me.prefix)).toHaveLength(1);
  });

  it('never lets a second sweep claim a push whose slow send is still in flight', async () => {
    const me = await customerWithDevice();
    const topic = await enqueue(me.id);

    sender().delay(1_500);

    try {
      const first = queue.sweep(new Date());

      await new Promise((resolve) => setTimeout(resolve, 300));

      // The lease is ahead: the second sweep finds nothing of this row due.
      const leased = await rowOf(topic!);

      expect(leased.attempts).toBe(1);
      expect(leased.retryAfter!.getTime()).toBeGreaterThan(
        Date.now() + PUSH_LEASE_MS / 2,
      );

      await queue.sweep(new Date());
      await first;
    } finally {
      sender().delay(0);
    }

    expect(sender().sentTo(me.prefix)).toHaveLength(1);
    expect(await rowOf(topic!)).toMatchObject({
      status: PushMessageStatus.SENT,
      attempts: 1,
    });
  });

  it('drops a staff push at dispatch once its recipient is deactivated', async () => {
    const kitchen = await createStaffAccount(prisma, StaffRole.KITCHEN, {
      emailPrefix: 'push-queue',
    });
    const prefix = fcmPrefix();

    await addDevice(prisma, { staffId: kitchen.id }, `${prefix}-tablet`);

    const topic = await prisma.$transaction((tx) =>
      queue.enqueueStaff(
        tx,
        'task.assigned',
        { taskId: asId(randomUUID()), version: 1 },
        { staffIds: [kitchen.id] },
      ),
    );

    expect(topic).not.toBeNull();

    await prisma.staff.update({
      where: { id: kitchen.id },
      data: { isActive: false },
    });
    await queue.dispatchTopics([topic]);

    expect(await rowOf(topic!)).toMatchObject({
      status: PushMessageStatus.DROPPED,
      dropReason: PushDropReason.RECIPIENT_GONE,
    });
    expect(sender().sentTo(prefix)).toHaveLength(0);
  });

  describe('isolation: a push defect never fails the event (D1)', () => {
    /** A Cashier and a Kitchen user with devices, so placement queues rows. */
    const staffWithDevices = async () => {
      const prefix = fcmPrefix();

      for (const role of [StaffRole.CASHIER, StaffRole.KITCHEN]) {
        const account = await createStaffAccount(prisma, role, {
          emailPrefix: 'push-isolation',
        });

        await addDevice(prisma, { staffId: account.id }, `${prefix}-${role}`);
      }

      return prefix;
    };

    /** The order, its payment and its checkout, all committed. */
    const expectPaid = async (onlineOrderId: string, reference: string) => {
      const online = await prisma.onlineOrder.findUniqueOrThrow({
        where: { id: onlineOrderId },
      });

      expect(
        await prisma.payment.count({ where: { providerRef: reference } }),
      ).toBe(1);
      expect(
        (await prisma.checkout.findUniqueOrThrow({ where: { reference } }))
          .status,
      ).toBe('PAID');

      return online;
    };

    it('commits the paid order when the push insert fails in SQL inside the settle', async () => {
      const prefix = await staffWithDevices();

      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION cnc_push_refuse_insert() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'push insert refused by the isolation test';
        END
        $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER cnc_push_refuse_insert
        BEFORE INSERT ON "PushMessage"
        FOR EACH ROW EXECUTE FUNCTION cnc_push_refuse_insert()`);

      let placed: { id: string; reference: string };

      try {
        placed = await placePaidWebOrder(app, PAYSTACK_KEY, dishSlug);
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER cnc_push_refuse_insert ON "PushMessage"',
        );
        await prisma.$executeRawUnsafe(
          'DROP FUNCTION cnc_push_refuse_insert()',
        );
      }

      await expectPaid(placed.id, placed.reference);
      expect(
        await prisma.pushMessage.count({
          where: { topic: `online:${placed.id}:placed` },
        }),
      ).toBe(0);
      expect(sender().sentTo(prefix)).toHaveLength(0);
    });

    it('commits the paid order when a catalogue builder throws', async () => {
      const prefix = await staffWithDevices();
      const build = jest
        .spyOn(PUSH_CATALOGUE['online_order.received'], 'build')
        .mockImplementation(() => {
          throw new Error('A broken entry.');
        });

      let placed: { id: string; reference: string };

      try {
        placed = await placePaidWebOrder(app, PAYSTACK_KEY, dishSlug);
      } finally {
        build.mockRestore();
      }

      await expectPaid(placed.id, placed.reference);
      expect(
        await prisma.pushMessage.count({
          where: {
            event: 'online_order.received',
            topic: { contains: placed.id },
          },
        }),
      ).toBe(0);
      // The docket's push is its own, and still went to the Kitchen.
      expect(
        sender()
          .sentTo(prefix)
          .map(({ payload }) => payload.title),
      ).toEqual([expect.stringMatching(/^New web docket KOT-CNCR-\d{6,}$/)]);
    });
  });
});
