import type { CncPrismaService } from '../prisma/cnc-prisma.service';
import {
  ATTENDANCE_RETENTION_YEARS,
  ENQUIRY_RETENTION_MONTHS,
  PUSH_MESSAGE_RETENTION_DAYS,
  PUSH_SUBSCRIPTION_UNUSED_DAYS,
  RETENTION_BATCH,
  RETENTION_MAX_BATCHES,
  RetentionSweepService,
  attendanceCutoff,
  enquiryCutoff,
  pushMessageCutoff,
  pushSubscriptionCutoff,
} from './retention-sweep.service';

describe('retention cutoffs (Q36)', () => {
  it('keeps enquiries twelve months and attendance two years', () => {
    expect(ENQUIRY_RETENTION_MONTHS).toBe(12);
    expect(ATTENDANCE_RETENTION_YEARS).toBe(2);
  });

  it('keeps every enquiry made from the start of the same Lagos date a year ago', () => {
    // 24 October 2026, 10:00 in Jos.
    expect(enquiryCutoff(new Date('2026-10-24T09:00:00.000Z'))).toEqual(
      new Date('2025-10-23T23:00:00.000Z'),
    );
  });

  it('takes the Lagos date, not the UTC one, in the hour they differ', () => {
    // 00:30 on 1 November 2026 in Jos is still 31 October in UTC.
    expect(enquiryCutoff(new Date('2026-10-31T23:30:00.000Z'))).toEqual(
      new Date('2025-10-31T23:00:00.000Z'),
    );
    expect(attendanceCutoff(new Date('2026-10-31T23:30:00.000Z'))).toEqual(
      new Date('2024-11-01T00:00:00.000Z'),
    );
  });

  it('keeps every shift dated from the same date two years ago', () => {
    expect(attendanceCutoff(new Date('2026-10-24T09:00:00.000Z'))).toEqual(
      new Date('2024-10-24T00:00:00.000Z'),
    );
  });

  it('rolls a date the earlier year lacks on to the next day, never back', () => {
    // 29 February 2028: two years earlier has no 29 February.
    expect(attendanceCutoff(new Date('2028-02-29T09:00:00.000Z'))).toEqual(
      new Date('2026-03-01T00:00:00.000Z'),
    );
  });
});

describe('RetentionSweepService', () => {
  const NOW = new Date('2026-10-24T09:00:00.000Z');

  /** A table that hands out `total` ids in batches and deletes them. */
  function table(total: number) {
    let left = total;
    const finds: unknown[] = [];
    const deletes: unknown[] = [];

    return {
      finds,
      deletes,
      findMany: jest.fn((args: { take: number }) => {
        finds.push(args);
        const n = Math.min(args.take, left);

        return Promise.resolve(
          Array.from({ length: n }, (_, i) => ({ id: `row-${left - i}` })),
        );
      }),
      deleteMany: jest.fn((args: { where: { id: { in: string[] } } }) => {
        deletes.push(args);
        left -= args.where.id.in.length;

        return Promise.resolve({ count: args.where.id.in.length });
      }),
    };
  }

  function harness(enquiries: number, shifts: number, pushes = 0, devices = 0) {
    const enquiry = table(enquiries);
    const attendanceRecord = table(shifts);
    const pushMessage = table(pushes);
    const customerPushSubscription = table(devices);
    const staffPushSubscription = table(devices);
    const service = new RetentionSweepService({
      enquiry,
      attendanceRecord,
      pushMessage,
      customerPushSubscription,
      staffPushSubscription,
    } as unknown as CncPrismaService);

    return {
      service,
      enquiry,
      attendanceRecord,
      pushMessage,
      customerPushSubscription,
      staffPushSubscription,
    };
  }

  it('reports each table’s count and whether rows remain', async () => {
    const { service } = harness(3, 0);

    await expect(service.sweep(NOW)).resolves.toEqual({
      enquiries: 3,
      attendanceRecords: 0,
      pushMessages: 0,
      pushSubscriptions: 0,
      more: false,
    });
  });

  it('keeps push rows 30 days and devices 180 days unused (C10)', () => {
    expect(PUSH_MESSAGE_RETENTION_DAYS).toBe(30);
    expect(PUSH_SUBSCRIPTION_UNUSED_DAYS).toBe(180);
    expect(pushMessageCutoff(NOW)).toEqual(
      new Date('2026-09-24T09:00:00.000Z'),
    );
    expect(pushSubscriptionCutoff(NOW)).toEqual(
      new Date('2026-04-27T09:00:00.000Z'),
    );
  });

  it('deletes push rows written before the cutoff, in any status, and counts them (C10)', async () => {
    const { service, pushMessage } = harness(0, 0, 4);

    await expect(service.sweep(NOW)).resolves.toMatchObject({
      pushMessages: 4,
      more: false,
    });
    expect(pushMessage.finds[0]).toEqual({
      where: { createdAt: { lt: new Date('2026-09-24T09:00:00.000Z') } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: RETENTION_BATCH,
      select: { id: true },
    });
    expect(pushMessage.deletes[0]).toMatchObject({
      where: { createdAt: { lt: new Date('2026-09-24T09:00:00.000Z') } },
    });
  });

  it('deletes devices neither seen nor delivered to for 180 days, in both realms, and counts them (C10)', async () => {
    const { service, customerPushSubscription, staffPushSubscription } =
      harness(0, 0, 0, 2);
    const cutoff = new Date('2026-04-27T09:00:00.000Z');
    const unused = {
      lastSeenAt: { lt: cutoff },
      OR: [{ lastSuccessAt: null }, { lastSuccessAt: { lt: cutoff } }],
    };

    await expect(service.sweep(NOW)).resolves.toMatchObject({
      pushSubscriptions: 4,
    });
    for (const devices of [customerPushSubscription, staffPushSubscription]) {
      expect(devices.finds[0]).toMatchObject({ where: unused });
      // The delete repeats the conditions: a device seen meanwhile stays.
      expect(devices.deletes[0]).toMatchObject({ where: unused });
    }
  });

  it('deletes only finished shifts dated before the cutoff, by date', async () => {
    const { service, attendanceRecord } = harness(0, 2);

    await service.sweep(NOW);

    expect(attendanceRecord.finds[0]).toMatchObject({
      where: {
        businessDate: { lt: new Date('2024-10-24T00:00:00.000Z') },
        timeOut: { not: null },
      },
      take: RETENTION_BATCH,
    });
    // The delete repeats the conditions, so a row changed after the select
    // is never caught.
    expect(attendanceRecord.deletes[0]).toMatchObject({
      where: {
        businessDate: { lt: new Date('2024-10-24T00:00:00.000Z') },
        timeOut: { not: null },
      },
    });
  });

  it('deletes enquiries made before the cutoff instant', async () => {
    const { service, enquiry } = harness(1, 0);

    await service.sweep(NOW);

    expect(enquiry.deletes[0]).toMatchObject({
      where: { createdAt: { lt: new Date('2025-10-23T23:00:00.000Z') } },
    });
  });

  it('works through full batches and stops at the first short one', async () => {
    const { service, enquiry } = harness(RETENTION_BATCH * 2 + 7, 0);

    await expect(service.sweep(NOW)).resolves.toMatchObject({
      enquiries: RETENTION_BATCH * 2 + 7,
      more: false,
    });
    expect(enquiry.findMany).toHaveBeenCalledTimes(3);
  });

  it('stops at the run’s cap and says more remain', async () => {
    const cap = RETENTION_BATCH * RETENTION_MAX_BATCHES;
    const { service, attendanceRecord } = harness(0, cap + 1);

    await expect(service.sweep(NOW)).resolves.toEqual({
      enquiries: 0,
      attendanceRecords: cap,
      pushMessages: 0,
      pushSubscriptions: 0,
      more: true,
    });
    expect(attendanceRecord.findMany).toHaveBeenCalledTimes(
      RETENTION_MAX_BATCHES,
    );
  });

  it('asks nothing to delete when nothing is past its period', async () => {
    const { service, enquiry, attendanceRecord } = harness(0, 0);

    await service.sweep(NOW);

    expect(enquiry.deleteMany).not.toHaveBeenCalled();
    expect(attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });
});
