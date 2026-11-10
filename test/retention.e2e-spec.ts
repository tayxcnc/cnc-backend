/*
 * The sweep route needs a token, set before the app is built (as the
 * sweeps suite does), so the suite does not depend on the developer's
 * `.env`.
 */
const SWEEP_TOKEN = `sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`;

process.env.CNC_SWEEP_TOKEN = SWEEP_TOKEN;

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { EnquiryKind, StaffRole } from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { SWEEP_TOKEN_HEADER } from '../src/internal/sweep-token.guard';
import {
  attendanceCutoff,
  enquiryCutoff,
  pushMessageCutoff,
  pushSubscriptionCutoff,
} from '../src/internal/retention-sweep.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';
import { staffQrPayload } from '../src/staff/staff-qr';
import { createTestApp } from './create-test-app';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

const HOUR_MS = 60 * 60 * 1000;

interface RetentionBody {
  enquiries: number;
  attendanceRecords: number;
  pushMessages: number;
  pushSubscriptions: number;
  more: boolean;
}

/**
 * `POST /api/v1/internal/sweeps/retention` (card C8-5, Q36): enquiries
 * older than twelve months and finished shifts older than two years are
 * deleted; the rows either side of each boundary, the open shift and every
 * audit row stay, and the reads that touch those people still answer. From
 * C10, push rows older than 30 days and push devices unused for 180 go too.
 *
 * On a database of its own: the sweep deletes across the whole table, and
 * on the shared database it would also take other suites' rows, and the
 * exact counts asserted here would be floors.
 */
describe('the retention sweep (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let ownerToken: string;
  let receptionToken: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    await seedData(prisma);

    const tokens = app.get(CncTokenService, { strict: false });
    const owner = await createStaffAccount(prisma, StaffRole.OWNER);
    const reception = await createStaffAccount(prisma, StaffRole.RECEPTION);

    ownerToken = await accessTokenFor(tokens, owner.id);
    receptionToken = await accessTokenFor(tokens, reception.id);
  }, 120_000);

  afterAll(async () => {
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const sweep = () =>
    request(server())
      .post('/api/v1/internal/sweeps/retention')
      .set(SWEEP_TOKEN_HEADER, SWEEP_TOKEN);

  const enquiry = (createdAt: Date, name: string) =>
    prisma.enquiry.create({
      data: {
        createdAt,
        kind: EnquiryKind.CONTACT,
        name,
        email: 'someone@cnc.test',
        message: 'Hello',
        ipHash: 'retention-test',
      },
      select: { id: true },
    });

  /**
   * One real scan through the route (so its audit row is the one a scan
   * writes), then the shift moved to `businessDate` and closed or left
   * open, as if it had been made then.
   */
  async function shift(businessDate: Date, open = false) {
    const person = await createStaffAccount(prisma, StaffRole.WAITER);
    const row = await prisma.staff.findUniqueOrThrow({
      where: { id: person.id },
      select: { staffNo: true, qrToken: true },
    });

    await request(server())
      .post('/api/v1/staff/attendance/scan')
      .set({ Authorization: `Bearer ${receptionToken}` })
      .send({ code: staffQrPayload(row.staffNo, row.qrToken) })
      .expect(200);

    const timeIn = new Date(businessDate.getTime() + 8 * HOUR_MS);
    const record = await prisma.attendanceRecord.findFirstOrThrow({
      where: { staffId: person.id },
    });

    await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: {
        businessDate,
        timeIn,
        timeOut: open ? null : new Date(timeIn.getTime() + 8 * HOUR_MS),
      },
    });

    return { id: record.id, staffId: person.id, staffNo: row.staffNo };
  }

  const auditOf = async (ref: string) =>
    (
      await request(server())
        .get(`/api/v1/staff/audit?ref=${ref}`)
        .set({ Authorization: `Bearer ${ownerToken}` })
        .expect(200)
    ).body as { total: number; data: { action: string; changes: string[] }[] };

  it('refuses a caller without the token', async () => {
    await request(server())
      .post('/api/v1/internal/sweeps/retention')
      .expect(401);
  });

  it('deletes enquiries older than 12 months and finished shifts older than 2 years, and nothing either side', async () => {
    const now = new Date();
    const enquiryEdge = enquiryCutoff(now);
    const shiftEdge = attendanceCutoff(now);

    const oldEnquiry = await enquiry(new Date(enquiryEdge.getTime() - 1), 'A');
    const edgeEnquiry = await enquiry(enquiryEdge, 'B');
    const newEnquiry = await enquiry(now, 'C');

    const oldShift = await shift(addDays(shiftEdge, -1));
    const edgeShift = await shift(shiftEdge);
    const openShift = await shift(addDays(shiftEdge, -400), true);

    // The old shift's correction is its own history: it goes with it.
    await prisma.attendanceCorrection.create({
      data: {
        recordId: oldShift.id,
        beforeIn: new Date(addDays(shiftEdge, -1).getTime() + 9 * HOUR_MS),
        reason: 'Scanned late',
        staffId: oldShift.staffId,
      },
    });

    const before = await auditOf(oldShift.staffNo);

    expect(before.total).toBeGreaterThan(0);

    const body = (await sweep().expect(200)).body as RetentionBody;

    expect(body).toEqual({
      enquiries: 1,
      attendanceRecords: 1,
      pushMessages: 0,
      pushSubscriptions: 0,
      more: false,
    });

    const enquiries = await prisma.enquiry.findMany({ select: { id: true } });

    expect(enquiries.map(({ id }) => id).sort()).toEqual(
      [edgeEnquiry.id, newEnquiry.id].sort(),
    );
    expect(await prisma.enquiry.count({ where: { id: oldEnquiry.id } })).toBe(
      0,
    );

    const shifts = await prisma.attendanceRecord.findMany({
      select: { id: true },
    });

    expect(shifts.map(({ id }) => id).sort()).toEqual(
      [edgeShift.id, openShift.id].sort(),
    );
    expect(
      await prisma.attendanceCorrection.count({
        where: { recordId: oldShift.id },
      }),
    ).toBe(0);

    // The audit log is never swept, and the person's history still reads.
    expect(await auditOf(oldShift.staffNo)).toEqual(before);

    // The kept shift's person still reads their month through the manager
    // read, as before.
    const month = await request(server())
      .get(
        `/api/v1/staff/attendance/${edgeShift.staffId}?from=${formatIsoDate(
          shiftEdge,
        )}&to=${formatIsoDate(shiftEdge)}`,
      )
      .set({ Authorization: `Bearer ${ownerToken}` })
      .expect(200);

    expect((month.body as { data: { id: string }[] }).data).toEqual([
      expect.objectContaining({ id: edgeShift.id }),
    ]);
  });

  it('is idempotent: a second run deletes nothing', async () => {
    expect((await sweep().expect(200)).body).toEqual({
      enquiries: 0,
      attendanceRecords: 0,
      pushMessages: 0,
      pushSubscriptions: 0,
      more: false,
    });
  });

  it('deletes in batches across several statements', async () => {
    const old = new Date(enquiryCutoff(new Date()).getTime() - HOUR_MS);

    await prisma.enquiry.createMany({
      data: Array.from({ length: 1_203 }, (_, i) => ({
        createdAt: new Date(old.getTime() - i * 1000),
        kind: EnquiryKind.CONTACT,
        name: `Batch ${i}`,
        email: 'batch@cnc.test',
        message: 'Hello',
        ipHash: 'retention-batch',
      })),
    });

    expect((await sweep().expect(200)).body).toEqual({
      enquiries: 1_203,
      attendanceRecords: 0,
      pushMessages: 0,
      pushSubscriptions: 0,
      more: false,
    });
    expect(
      await prisma.enquiry.count({ where: { ipHash: 'retention-batch' } }),
    ).toBe(0);
  });

  it('deletes push rows older than 30 days and devices unused for 180, and counts them (C10)', async () => {
    const now = new Date();
    const messageEdge = pushMessageCutoff(now).getTime();
    const deviceEdge = pushSubscriptionCutoff(now).getTime();
    const customer = await prisma.customer.create({
      data: {
        memberNo: await drawNumber(prisma, 'customer'),
        name: 'Retention Push',
        email: `retention-push-${Date.now()}@cnc.test`,
      },
    });
    const staff = await createStaffAccount(prisma, StaffRole.KITCHEN);
    const message = (key: string, createdAt: Date) =>
      prisma.pushMessage.create({
        data: {
          createdAt,
          customerId: customer.id,
          event: 'order.preparing',
          topic: key,
          dedupeKey: key,
          title: 'Order WEB-000001 is being prepared',
          body: 'The kitchen has started on your order.',
          tag: key,
          status: 'SENT',
          expiresAt: new Date(createdAt.getTime() + HOUR_MS),
        },
        select: { id: true },
      });
    const device = (
      owner: { customerId: string } | { staffId: string },
      lastSeenAt: number,
      lastSuccessAt: number | null,
    ) => {
      const fields = {
        endpoint: `https://fcm.googleapis.com/fcm/send/retention-${Math.random()}`,
        p256dh: 'p'.repeat(87),
        auth: 'a'.repeat(22),
        lastSeenAt: new Date(lastSeenAt),
        lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt),
      };

      return 'customerId' in owner
        ? prisma.customerPushSubscription.create({
            data: { ...fields, customerId: owner.customerId },
            select: { id: true },
          })
        : prisma.staffPushSubscription.create({
            data: { ...fields, staffId: owner.staffId },
            select: { id: true },
          });
    };

    const old = await message('retention:old', new Date(messageEdge - HOUR_MS));
    const kept = await message(
      'retention:kept',
      new Date(messageEdge + HOUR_MS),
    );

    // Seen long ago and never delivered to: gone.
    const unused = await device(
      { customerId: customer.id },
      deviceEdge - HOUR_MS,
      null,
    );
    // Seen long ago but delivered to lately: kept.
    const delivering = await device(
      { customerId: customer.id },
      deviceEdge - 20 * 24 * HOUR_MS,
      now.getTime() - 24 * HOUR_MS,
    );
    // A staff device neither seen nor delivered to for 180 days: gone.
    const staffUnused = await device(
      { staffId: staff.id },
      deviceEdge - 2 * HOUR_MS,
      deviceEdge - HOUR_MS,
    );

    expect((await sweep().expect(200)).body).toEqual({
      enquiries: 0,
      attendanceRecords: 0,
      pushMessages: 1,
      pushSubscriptions: 2,
      more: false,
    });

    expect(
      await prisma.pushMessage.findMany({
        where: { id: { in: [old.id, kept.id] } },
        select: { id: true },
      }),
    ).toEqual([{ id: kept.id }]);
    expect(
      await prisma.customerPushSubscription.findMany({
        where: { id: { in: [unused.id, delivering.id] } },
        select: { id: true },
      }),
    ).toEqual([{ id: delivering.id }]);
    expect(
      await prisma.staffPushSubscription.count({
        where: { id: staffUnused.id },
      }),
    ).toBe(0);
  });
});
