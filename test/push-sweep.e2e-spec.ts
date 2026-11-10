/*
 * The sweep token, set before the app is built so the guard reads this
 * suite's value whatever the developer's `.env` holds (see `sweeps`).
 */
const SWEEP_TOKEN = `push-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`;

process.env.CNC_SWEEP_TOKEN = SWEEP_TOKEN;

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  OrderStatus,
  ReservationSource,
  StaffRole,
  TableSessionStatus,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import type { PushSweepResult } from '../src/internal/push-sweep.service';
import { SWEEP_TOKEN_HEADER } from '../src/internal/sweep-token.guard';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';
import { TableSessionsService } from '../src/reception/table-sessions.service';
import { createTestApp, pushSender } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { addDevice, fcmPrefix } from './push-devices';
import { createStaffAccount } from './staff-fixtures';

const HOUR = 60 * 60 * 1000;

/**
 * `POST /internal/sweeps/push` (C10, spec §2.7): the clock's staff pushes
 * (PS12 for each seating past its Free Table Reminder; the 09:00 digests,
 * PS11 and PS13) and the queue's own sweep, each phase on its own.
 *
 * On a database of its own with the real seeds, where Reception, a
 * Cashier and the managers are the only staff, each with a device. Now is
 * the next noon in Jos; the digests' tests move the clock to 09:30 the
 * next morning.
 */
describe('Push sweep (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  const NOON = nextNoonInJos();
  const people = {
    reception: StaffRole.RECEPTION,
    cashier: StaffRole.CASHIER,
    manager: StaffRole.MANAGER,
    owner: StaffRole.OWNER,
  } as const;
  const id = {} as Record<keyof typeof people, string>;
  const prefix = fcmPrefix();

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);

    await seedData(prisma);
    fakeDateOnly(NOON);

    for (const [name, role] of Object.entries(people) as [
      keyof typeof people,
      StaffRole,
    ][]) {
      id[name] = (
        await createStaffAccount(prisma, role, {
          emailPrefix: `push-sweep-${name}`,
        })
      ).id;
      await addDevice(prisma, { staffId: id[name] }, `${prefix}-${name}`);
    }
  }, 120_000);

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const sweep = async (token = SWEEP_TOKEN, status = 200) =>
    (
      await request(app.getHttpServer())
        .post('/api/v1/internal/sweeps/push')
        .set(SWEEP_TOKEN_HEADER, token)
        .expect(status)
    ).body as PushSweepResult;

  const holders = async (topicStart: string) =>
    (
      await prisma.pushMessage.findMany({
        where: { topic: { startsWith: topicStart } },
        select: { staffId: true },
      })
    )
      .map(({ staffId }) =>
        (Object.keys(id) as (keyof typeof people)[]).find(
          (name) => id[name] === staffId,
        ),
      )
      .sort();

  const table = async (code: string) =>
    prisma.diningTable.findFirstOrThrow({
      where: { code, venue: { slug: 'dining' } },
      select: { id: true, name: true },
    });

  it('refuses a wrong token with 401, before any phase runs', async () => {
    await sweep('not-the-token', 401);
  });

  it('pushes Reception once per seating still occupied past the reminder', async () => {
    const at = await table('B2');
    const seat = (since: Date) =>
      prisma.tableSession.create({
        data: {
          tableId: at.id,
          status: TableSessionStatus.OCCUPIED,
          guest: 'Funmi',
          party: 2,
          since,
          openedById: id.reception,
        },
      });
    const first = await seat(new Date(Date.now() - 4 * HOUR));

    const result = await sweep();

    expect(result).toMatchObject({
      queued: { staleTables: 1, dailyDigests: 0 },
      failed: [],
    });
    expect(result.delivered).toBeGreaterThanOrEqual(1);
    expect(await holders(`free:${at.id}:`)).toEqual(['reception']);
    expect(
      pushSender(app)
        .sentTo(`${prefix}-reception`)
        .map(({ payload }) => payload),
    ).toEqual([
      expect.objectContaining({
        title: `Table ${at.name} still occupied`,
        body: 'Seated for 4 h 0 min. Free it if the guests have left.',
        link: '/#reception',
      }),
    ]);

    // The next run: the same seating, nothing new.
    await sweep();
    expect(await holders(`free:${at.id}:`)).toEqual(['reception']);
    expect(pushSender(app).sentTo(`${prefix}-reception`)).toHaveLength(1);

    // Freed and seated again: a new seating, a new push.
    await prisma.tableSession.update({
      where: { id: first.id },
      data: { endedAt: new Date() },
    });
    await seat(new Date(Date.now() - 3.5 * HOUR));
    await sweep();
    expect(await holders(`free:${at.id}:`)).toEqual(['reception', 'reception']);

    await prisma.tableSession.updateMany({
      where: { tableId: at.id, endedAt: null },
      data: { endedAt: new Date() },
    });
  });

  it('runs the other phases when one throws, and names it', async () => {
    const tables = app.get(TableSessionsService, { strict: false });
    const broken = jest
      .spyOn(tables, 'seatingsDueReminder')
      .mockRejectedValue(new Error('A broken read.'));

    try {
      const result = await sweep();

      expect(result.failed).toEqual(['staleTables']);
      expect(result.queued).toEqual({ staleTables: null, dailyDigests: 0 });
      expect(result.delivered).toEqual(expect.any(Number));
      expect(result.held).toEqual(expect.any(Number));
    } finally {
      broken.mockRestore();
    }
  });

  describe('the daily digests (PS11, PS13)', () => {
    const today = () => watToday(new Date());

    beforeAll(async () => {
      // Two Confirmed bookings for tomorrow, and a bill left open today:
      // tomorrow at 09:30 they are the day's arrivals and an unsettled bill.
      const tomorrow = addDays(today(), 1);

      for (const [code, startMinutes] of [
        ['B3', 19 * 60],
        ['B4', 13 * 60 + 30],
      ] as const) {
        await prisma.reservation.create({
          data: {
            number: await drawNumber(prisma, 'reservation'),
            tableId: (await table(code)).id,
            name: 'Bisi',
            phone: '08031111111',
            businessDate: tomorrow,
            startMinutes,
            party: 2,
            source: ReservationSource.RECEPTION,
          },
        });
      }

      await prisma.order.create({
        data: {
          number: await drawNumber(prisma, 'orderRestaurant'),
          department: Department.RESTAURANT,
          label: 'Table 4',
          businessDate: today(),
          status: OrderStatus.OPEN,
          vatBps: 750,
          serviceBps: 0,
          openedById: id.cashier,
        },
      });
    });

    it('sends none outside 09:00 to 10:00 in Jos', async () => {
      // Noon: nothing, though there are bookings and a bill.
      const result = await sweep();

      expect(result.queued.dailyDigests).toBe(0);
      expect(await holders('arrivals:')).toEqual([]);
      expect(await holders('unsettled:')).toEqual([]);
    });

    it('sends each once in the 09:00 hour: arrivals to Reception, unsettled bills to the Cashier and the managers', async () => {
      // 09:30 the next morning in Jos.
      jest.setSystemTime(NOON + 21.5 * HOUR);

      const day = formatIsoDate(today());
      const first = await sweep();

      expect(first.queued.dailyDigests).toBe(2);
      expect(await holders(`arrivals:${day}`)).toEqual(['reception']);
      expect(await holders(`unsettled:${day}`)).toEqual([
        'cashier',
        'manager',
        'owner',
      ]);
      expect(
        pushSender(app)
          .sentTo(`${prefix}-reception`)
          .map(({ payload }) => payload)
          .at(-1),
      ).toMatchObject({
        title: '2 bookings today',
        body: 'The first is at 13:30. Open Reception.',
      });
      expect(
        pushSender(app)
          .sentTo(`${prefix}-cashier`)
          .map(({ payload }) => payload.title),
      ).toEqual(['1 bill left open from a previous day']);

      // Again in the hour: nothing new.
      await sweep();
      expect(await holders(`arrivals:${day}`)).toEqual(['reception']);
      expect(await holders(`unsettled:${day}`)).toHaveLength(3);
      expect(pushSender(app).sentTo(`${prefix}-cashier`)).toHaveLength(1);

      // Past 10:00: still nothing new.
      jest.setSystemTime(NOON + 22.5 * HOUR);
      expect((await sweep()).queued.dailyDigests).toBe(0);
    });
  });
});
