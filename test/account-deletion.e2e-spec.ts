/*
 * CNC's Paystack key for this suite, set before the app is built. It signs
 * this suite's fake webhooks only: the client is `FakePaystackClient`.
 */
const PAYSTACK_KEY = 'sk_test_cnc_account_deletion_e2e_not_a_real_key';

process.env.CNC_PAYSTACK_SECRET_KEY = PAYSTACK_KEY;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  OnlineFulfilmentStatus,
  StaffRole,
  SubjectType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { DELETED_CUSTOMER_NAME } from '../src/customers/customer-deletion.service';
import { CustomerService } from '../src/customers/customer.service';
import { WebhookDispatcherService } from '../src/payments/webhook-dispatcher.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { chargeSuccessBody, postSignedWebhook } from './paystack-webhooks';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';
import { clientAddress } from './staff-sessions';

interface AuditPage {
  data: { action: string; actorName: string; changes: string[] }[];
}

/**
 * Card C8-5: deleting an account (Q36) leaves nothing that keeps the
 * person's email, phone or address, except the audit log, which is
 * append-only (A13) and is withheld at the read.
 *
 * The person meets CNC the ways a guest does before they have an account:
 * a guest web order (paid through the signed fake webhook, then edited by
 * a manager and delivered), an enquiry, then an account under the same
 * email and a Reception booking linked to it (Q35). After `DELETE /me`
 * every table but `AuditLog` is searched for each of their details.
 *
 * On a database of its own, so the search over every table reads only
 * this suite's rows, with the clock at the next noon in Jos.
 */
describe('deleting an account forgets the person (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let dispatcher: WebhookDispatcherService;
  const token: Partial<Record<StaffRole, string>> = {};

  const email = `ngozi-${randomUUID()}@cnc.test`;
  const name = 'Ngozi Bello';
  const checkoutPhone = '08091112233';
  const editedPhone = '08094445566';
  const bookingPhone = '08097778899';
  const street = `${randomUUID().slice(0, 8)} Rayfield Road`;
  const landmark = 'Behind the blue gate';

  let orderNumber: string;
  let onlineId: string;
  let bookingNumber: string;
  let tableRef: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    dispatcher = app.get(WebhookDispatcherService, { strict: false });
    await seedData(prisma);
    fakeDateOnly(nextNoonInJos());

    const tokens = app.get(CncTokenService, { strict: false });

    for (const role of [
      StaffRole.OWNER,
      StaffRole.MANAGER,
      StaffRole.CASHIER,
      StaffRole.RECEPTION,
    ]) {
      token[role] = await accessTokenFor(
        tokens,
        (await createStaffAccount(prisma, role)).id,
      );
    }
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
  const details = [
    email,
    name,
    checkoutPhone,
    editedPhone,
    bookingPhone,
    street,
    landmark,
  ];

  /** Every public table whose row, as text, carries `needle`. */
  async function tablesHolding(needle: string): Promise<string[]> {
    const tables = await prisma.$queryRaw<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        AND table_name <> '_prisma_migrations'`;
    const holding: string[] = [];

    for (const { name: table } of tables) {
      const [{ count }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) AS count FROM "${table}" t WHERE strpos(t::text, $1) > 0`,
        needle,
      );

      if (count > 0n) holding.push(table);
    }

    return holding;
  }

  it('a guest web order under the email, edited and delivered', async () => {
    const online = { active: true, showOnline: true };
    const food = await prisma.menuItem.findFirstOrThrow({
      where: {
        ...online,
        department: Department.RESTAURANT,
        choiceOptions: { isEmpty: true },
        priceKobo: { gt: 0 },
      },
      orderBy: { slug: 'asc' },
    });

    const created = (
      await request(server())
        .post('/api/v1/checkouts')
        .set('Idempotency-Key', randomUUID())
        .set('X-Forwarded-For', clientAddress())
        .send({
          lines: [{ dishId: food.slug, qty: 2 }],
          fulfilment: 'DELIVERY',
          address: {
            zone: 'JOS',
            street,
            area: 'Rayfield',
            town: 'Jos',
            landmark,
          },
          timing: 'ASAP',
          name,
          phone: checkoutPhone,
          email,
          note: 'Ring twice',
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
      include: { order: { select: { number: true } } },
    });

    expect(row.customerId).toBeNull();
    onlineId = row.id;
    orderNumber = row.order.number;

    const version = async () =>
      (
        (
          await request(server())
            .get(`/api/v1/staff/online-orders/${onlineId}`)
            .set(auth(StaffRole.MANAGER))
            .expect(200)
        ).body as { version: number }
      ).version;

    // The manager's edit writes the old and new phone into its audit row,
    // and takes one dish off: a refund is owed.
    await request(server())
      .post(`/api/v1/staff/online-orders/${onlineId}/edit`)
      .set(auth(StaffRole.MANAGER))
      .send({
        version: await version(),
        lines: [{ menuItemId: food.id, qty: 1 }],
        contactPhone: editedPhone,
        reason: 'Guest called with a new number',
      })
      .expect(200);

    // Refunded by transfer: the payment names the guest as its recipient.
    await request(server())
      .post(`/api/v1/staff/online-orders/${onlineId}/balance`)
      .set(auth(StaffRole.OWNER))
      .set('Idempotency-Key', randomUUID())
      .send({
        version: await version(),
        method: 'TRANSFER',
        sender: name,
        reference: 'TRF-DELETION-1',
        reason: 'Refund the second dish',
      })
      .expect(200);
    expect(
      await prisma.payment.count({
        where: { order: { number: orderNumber }, sender: name },
      }),
    ).toBe(1);

    for (const status of [
      OnlineFulfilmentStatus.PREPARING,
      OnlineFulfilmentStatus.ON_THE_WAY,
      OnlineFulfilmentStatus.DELIVERED,
    ]) {
      await request(server())
        .post(`/api/v1/staff/online-orders/${onlineId}/status`)
        .set(auth(StaffRole.CASHIER))
        .send({ version: await version(), status })
        .expect(200);
    }
  });

  it('an enquiry, an account under the same email, and a Reception booking linked to it', async () => {
    await request(server())
      .post('/api/v1/enquiries')
      .set('X-Forwarded-For', clientAddress())
      .send({ name, email, subject: 'Birthday', message: 'Do you do cakes?' })
      .expect(204);

    const customers = app.get(CustomerService, { strict: false });
    const customer = await prisma.$transaction((tx) =>
      customers.findOrCreateVerified(tx, email),
    );
    const tokens = app.get(CncTokenService, { strict: false });
    const { accessToken } = await tokens.issueTokenPair(
      customer.id,
      SubjectType.CUSTOMER,
    );

    const table = await prisma.diningTable.findFirstOrThrow({
      where: { active: true },
      orderBy: [{ venueId: 'asc' }, { code: 'asc' }],
    });
    const booked = (
      await request(server())
        .post('/api/v1/staff/reservations')
        .set(auth(StaffRole.RECEPTION))
        .set('Idempotency-Key', randomUUID())
        .send({
          tableId: table.id,
          name,
          phone: bookingPhone,
          email,
          party: 2,
          businessDate: formatIsoDate(addDays(watToday(new Date()), 1)),
          time: '19:00',
        })
        .expect(201)
    ).body as { id: string; number: string; version: number };

    bookingNumber = booked.number;
    expect(
      (await prisma.reservation.findUniqueOrThrow({ where: { id: booked.id } }))
        .customerId,
    ).toBe(customer.id);

    // A booking still ahead would be unlinked and kept; this one is over.
    await request(server())
      .post(`/api/v1/staff/reservations/${booked.id}/cancel`)
      .set(auth(StaffRole.RECEPTION))
      .send({ version: booked.version })
      .expect(200);

    // Another, for today: checked in (the seating takes the booking's
    // name) and the table released, so the booking is Completed and the
    // release's audit row, under the table's ref, names the guest.
    const seatAt = await prisma.diningTable.findFirstOrThrow({
      where: { active: true, id: { not: table.id }, capacity: { gte: 2 } },
      orderBy: [{ venueId: 'asc' }, { code: 'asc' }],
    });
    const tonight = (
      await request(server())
        .post('/api/v1/staff/reservations')
        .set(auth(StaffRole.RECEPTION))
        .set('Idempotency-Key', randomUUID())
        .send({
          tableId: seatAt.id,
          name,
          phone: bookingPhone,
          email,
          party: 2,
          businessDate: formatIsoDate(watToday(new Date())),
          time: '19:00',
        })
        .expect(201)
    ).body as { id: string; number: string; version: number };
    const seated = (
      await request(server())
        .post(`/api/v1/staff/reservations/${tonight.id}/check-in`)
        .set(auth(StaffRole.RECEPTION))
        .send({ version: tonight.version })
        .expect(200)
    ).body as { session: { id: string; version: number; tableRef: string } };

    expect(seated.session).toMatchObject({ guest: name });
    tableRef = seated.session.tableRef;

    await request(server())
      .post(`/api/v1/staff/tables/${seatAt.id}/release`)
      .set(auth(StaffRole.RECEPTION))
      .send({ sessionId: seated.session.id, version: seated.session.version })
      .expect(200);

    await request(server())
      .delete('/api/v1/me')
      .set({ Authorization: `Bearer ${accessToken}` })
      .expect(204);
  });

  it('leaves the email, phones, name and address in no table but the audit log', async () => {
    for (const detail of details) {
      const holding = await tablesHolding(detail);

      expect({
        detail,
        holding: holding.filter((t) => t !== 'AuditLog'),
      }).toEqual({ detail, holding: [] });
    }

    // The audit log keeps what it recorded (A13): the reason for the read
    // below.
    expect(await tablesHolding(bookingPhone)).toEqual(['AuditLog']);
    expect(await prisma.enquiry.count()).toBe(0);
  });

  it('withholds the guest’s values from the audit rows about their records', async () => {
    for (const ref of [bookingNumber, orderNumber, tableRef]) {
      const response = await request(server())
        .get(`/api/v1/staff/audit?ref=${ref}`)
        .set(auth(StaffRole.OWNER))
        .expect(200);
      const text = JSON.stringify(response.body);

      for (const detail of details) expect(text).not.toContain(detail);
    }

    const booking = (
      await request(server())
        .get(`/api/v1/staff/audit?ref=${bookingNumber}`)
        .set(auth(StaffRole.OWNER))
        .expect(200)
    ).body as AuditPage;

    expect(
      booking.data.find((row) => row.action === 'reservation.create')?.changes,
    ).toEqual(
      expect.arrayContaining([
        'Name not shown: the customer deleted their account.',
        'Phone not shown: the customer deleted their account.',
        'Email not shown: the customer deleted their account.',
        'Party: 2.',
      ]),
    );

    const order = (
      await request(server())
        .get(`/api/v1/staff/audit?ref=${orderNumber}`)
        .set(auth(StaffRole.OWNER))
        .expect(200)
    ).body as AuditPage;

    expect(
      order.data.find((row) => row.action === 'online.edit')?.changes,
    ).toContain(
      'Contact Phone changed, not shown: the customer deleted their account.',
    );

    // The release is under the table's ref, not the booking's.
    const table = (
      await request(server())
        .get(`/api/v1/staff/audit?ref=${tableRef}`)
        .set(auth(StaffRole.OWNER))
        .expect(200)
    ).body as AuditPage;

    expect(
      table.data.find((row) => row.action === 'table.release')?.changes,
    ).toEqual([
      'Guest changed, not shown: the customer deleted their account.',
      'Party changed from 2 to blank.',
      'Status changed from Occupied to Available.',
    ]);
  });

  it('shows staff the anonymised records without the person', async () => {
    const online = await request(server())
      .get(`/api/v1/staff/online-orders/${onlineId}`)
      .set(auth(StaffRole.CASHIER))
      .expect(200);

    expect(online.body).toMatchObject({ contactName: DELETED_CUSTOMER_NAME });

    for (const detail of details) {
      expect(JSON.stringify(online.body)).not.toContain(detail);
    }
  });
});
