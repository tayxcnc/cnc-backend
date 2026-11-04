import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { StaffRole, TableKind } from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { DELIVERY_ZONE_MESSAGE } from '../src/common/delivery-address';
import { watToday } from '../src/common/wat';
import { FULFILMENT_MESSAGE } from '../src/ordering/dto/ordering.dto';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import {
  PAST_DATE_MESSAGE,
  RESERVATION_DATE_MESSAGE,
  VENUE_NOT_FOUND_MESSAGE,
} from '../src/reception/reception-messages';
import { createTestApp } from './create-test-app';
import { fakeDateOnly, nextNoonInJos } from './fake-date';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

interface MenuBody {
  categories: {
    slug: string;
    title: string;
    note: string | null;
    kind: string;
    items: Record<string, unknown>[];
  }[];
}

interface AvailabilityBody {
  venue: string;
  date: string;
  arrivalTimes: string[];
  tables: { code: string; status: string }[];
}

interface SlotsBody {
  asap: boolean;
  leadMinutes: number;
  todayDate: string;
  today: string[];
  tomorrowDate: string;
  tomorrow: string[];
}

const HOUR = 60 * 60 * 1000;

/**
 * The public reads (plan §5.1, card C6-4) through HTTP, with no token:
 * the menu (Q37), the business details, the opening hours, the rooms and a
 * room's availability, and the ordering config and slots.
 *
 * On a database of its own (`createIsolatedDatabase`) seeded with the real
 * reference data and menu, because it hides seeded dishes, changes a
 * price, closes a day and books the venue's own tables, all of which every
 * other suite shares. Only `Date` is faked, from the next 12:00 in Jos, so
 * the slot lists are known exactly; the clock only moves forward.
 */
describe('public reads (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  let ownerId: string;
  let receptionId: string;
  let noon: number;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);

    noon = nextNoonInJos();
    fakeDateOnly(noon);

    ownerId = (
      await createStaffAccount(prisma, StaffRole.OWNER, {
        emailPrefix: 'public-reads',
      })
    ).id;
    receptionId = (
      await createStaffAccount(prisma, StaffRole.RECEPTION, {
        emailPrefix: 'public-reads',
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    jest.useRealTimers();
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;
  const get = (path: string) => request(server()).get(`/api/v1${path}`);
  const asStaff = async (staffId: string) => ({
    Authorization: `Bearer ${await accessTokenFor(tokens, staffId)}`,
  });
  const dayFromToday = (days: number) =>
    formatIsoDate(addDays(watToday(new Date()), days));

  describe('GET /menu', () => {
    const menu = async () => (await get('/menu').expect(200)).body as MenuBody;
    const findItem = (body: MenuBody, slug: string) =>
      body.categories
        .flatMap((category) => category.items)
        .find((item) => item.slug === slug);

    it('answers without a token, cached for a minute, with nothing internal', async () => {
      const response = await get('/menu').expect(200);

      expect(response.headers['cache-control']).toBe('public, max-age=60');

      const body = response.body as MenuBody;
      const seeded = await prisma.menuCategory.findMany({
        orderBy: [{ sort: 'asc' }, { slug: 'asc' }],
        select: { slug: true },
      });

      expect(body.categories.length).toBeGreaterThan(0);
      // In the customer categories' order.
      const order = seeded.map((category) => category.slug);
      const shown = body.categories.map((category) => category.slug);
      expect(shown).toEqual(order.filter((slug) => shown.includes(slug)));

      for (const category of body.categories) {
        expect(Object.keys(category).sort()).toEqual(
          ['items', 'kind', 'note', 'slug', 'title'].sort(),
        );
        for (const item of category.items) {
          expect(Object.keys(item).sort()).toEqual(
            [
              'choice',
              'description',
              'group',
              'name',
              'photoAlt',
              'photoUrl',
              'priceKobo',
              'signature',
              'slug',
              'thumbUrl',
            ].sort(),
          );
        }
      }

      for (const forbidden of [
        'version',
        'stockItemId',
        'legacyStaffId',
        'staffCategory',
        'showOnline',
        'costKobo',
      ]) {
        expect(response.text).not.toContain(`"${forbidden}"`);
      }
    });

    it('carries a dish’s choice', async () => {
      const dish = await prisma.menuItem.findFirstOrThrow({
        where: {
          active: true,
          showOnline: true,
          NOT: { choiceOptions: { isEmpty: true } },
        },
      });

      expect(findItem(await menu(), dish.slug)).toMatchObject({
        name: dish.name,
        priceKobo: dish.priceKobo,
        choice: { label: dish.choiceLabel, options: dish.choiceOptions },
      });
    });

    it('hides a dish that is unavailable or not shown online (Q37), and shows it again', async () => {
      const dish = await prisma.menuItem.findFirstOrThrow({
        where: { active: true, showOnline: true },
        orderBy: { slug: 'asc' },
      });

      expect(findItem(await menu(), dish.slug)).toBeDefined();

      await prisma.menuItem.update({
        where: { id: dish.id },
        data: { active: false },
      });
      expect(findItem(await menu(), dish.slug)).toBeUndefined();

      await prisma.menuItem.update({
        where: { id: dish.id },
        data: { active: true, showOnline: false },
      });
      expect(findItem(await menu(), dish.slug)).toBeUndefined();

      await prisma.menuItem.update({
        where: { id: dish.id },
        data: { showOnline: true },
      });
      expect(findItem(await menu(), dish.slug)).toBeDefined();
    });

    it('leaves out a category with no dish to show', async () => {
      const category = await prisma.menuCategory.findFirstOrThrow({
        where: { menuItems: { some: {} } },
        orderBy: { sort: 'asc' },
      });
      const hidden = await prisma.menuItem.findMany({
        where: { menuCategoryId: category.id, showOnline: true },
        select: { id: true },
      });

      await prisma.menuItem.updateMany({
        where: { id: { in: hidden.map((row) => row.id) } },
        data: { showOnline: false },
      });

      try {
        const body = await menu();

        expect(body.categories.map((row) => row.slug)).not.toContain(
          category.slug,
        );
      } finally {
        await prisma.menuItem.updateMany({
          where: { id: { in: hidden.map((row) => row.id) } },
          data: { showOnline: true },
        });
      }
    });

    it('shows a price the Owner changes on the very next read, cached for a minute at most (C6 gate step 8, B2)', async () => {
      const dish = await prisma.menuItem.findFirstOrThrow({
        where: { active: true, showOnline: true },
        orderBy: { slug: 'desc' },
      });
      const newPrice = dish.priceKobo + 50000;

      const before = await get('/menu').expect(200);
      const etag = before.headers.etag;

      expect(findItem(before.body as MenuBody, dish.slug)?.priceKobo).toBe(
        dish.priceKobo,
      );

      await request(server())
        .patch(`/api/v1/staff/menu/${dish.id}`)
        .set(await asStaff(ownerId))
        .send({ priceKobo: newPrice, version: dish.version })
        .expect(200);

      // A page holding the old answer asks again with its ETag: the menu
      // has changed, so it gets the new price, not a 304.
      const after = await get('/menu').set('If-None-Match', etag).expect(200);

      expect(after.headers['cache-control']).toBe('public, max-age=60');
      expect(after.headers.etag).not.toBe(etag);
      expect(findItem(after.body as MenuBody, dish.slug)?.priceKobo).toBe(
        newPrice,
      );
    });

    it('hides a dish on the very next read once staff mark it unavailable (B2)', async () => {
      const dish = await prisma.menuItem.findFirstOrThrow({
        where: { active: true, showOnline: true },
        orderBy: { slug: 'asc' },
        skip: 2,
      });
      const etag = (await get('/menu').expect(200)).headers.etag;

      const saved = await request(server())
        .patch(`/api/v1/staff/menu/${dish.id}`)
        .set(await asStaff(ownerId))
        .send({ active: false, version: dish.version })
        .expect(200);

      try {
        const after = await get('/menu').set('If-None-Match', etag).expect(200);

        expect(after.headers['cache-control']).toBe('public, max-age=60');
        expect(findItem(after.body as MenuBody, dish.slug)).toBeUndefined();
      } finally {
        await request(server())
          .patch(`/api/v1/staff/menu/${dish.id}`)
          .set(await asStaff(ownerId))
          .send({
            active: true,
            version: (saved.body as { version: number }).version,
          })
          .expect(200);
      }
    });

    it('compresses the menu for a client that asks, and not for one that does not (B2)', async () => {
      const gzipped = await get('/menu')
        .set('Accept-Encoding', 'gzip')
        .expect(200);
      const brotli = await get('/menu')
        .set('Accept-Encoding', 'br')
        .expect(200);
      const plain = await get('/menu')
        .set('Accept-Encoding', 'identity')
        .expect(200);

      expect(gzipped.headers['content-encoding']).toBe('gzip');
      expect(brotli.headers['content-encoding']).toBe('br');
      expect(plain.headers['content-encoding']).toBeUndefined();
      expect(gzipped.headers.vary).toMatch(/accept-encoding/i);
      expect(gzipped.headers['cache-control']).toBe('public, max-age=60');
      expect(gzipped.body).toEqual(plain.body);
      expect(brotli.body).toEqual(plain.body);
      expect((plain.body as MenuBody).categories.length).toBeGreaterThan(0);
    });

    it('answers 304 to a conditional request while nothing has changed, photo links included (B2)', async () => {
      const dish = await prisma.menuItem.findFirstOrThrow({
        where: { active: true, showOnline: true },
        orderBy: { slug: 'asc' },
        skip: 3,
      });

      await prisma.menuItem.update({
        where: { id: dish.id },
        data: {
          photo: `gs://cnc-test-media/menu/${dish.id}/photo-${randomUUID()}.jpg`,
          photoThumb: `gs://cnc-test-media/menu/${dish.id}/thumb-${randomUUID()}.webp`,
        },
      });

      try {
        const first = await get('/menu').expect(200);
        const etag = first.headers.etag;

        expect(etag).toMatch(/^W\/"/);

        // The links are handed out again rather than signed afresh, so the
        // body and its ETag hold from one read to the next.
        const again = await get('/menu').expect(200);

        expect(again.headers.etag).toBe(etag);
        expect(findItem(again.body as MenuBody, dish.slug)).toEqual(
          findItem(first.body as MenuBody, dish.slug),
        );

        const unchanged = await get('/menu')
          .set('If-None-Match', etag)
          .expect(304);

        expect(unchanged.text ?? '').toBe('');
        expect(unchanged.headers['cache-control']).toBe('public, max-age=60');
      } finally {
        await prisma.menuItem.update({
          where: { id: dish.id },
          data: { photo: null, photoThumb: null },
        });
      }
    });

    it('signs a photo and its thumbnail as links valid for an hour, never the gs:// address', async () => {
      const dish = await prisma.menuItem.findFirstOrThrow({
        where: { active: true, showOnline: true },
        orderBy: { name: 'asc' },
      });

      await prisma.menuItem.update({
        where: { id: dish.id },
        data: {
          photo: `gs://cnc-test-media/menu/${dish.id}/${randomUUID()}.webp`,
          photoThumb: `gs://cnc-test-media/menu/${dish.id}/thumb-${randomUUID()}.webp`,
          photoAlt: 'A plate',
        },
      });

      const response = await get('/menu').expect(200);
      const item = findItem(response.body as MenuBody, dish.slug);
      const lifeOf = (url: unknown) =>
        new URL(String(url)).searchParams.get('X-Goog-Expires');

      expect(item?.photoUrl).toMatch(/^https:\/\/storage\.test\/.+\/menu\//);
      expect(item?.thumbUrl).toMatch(
        /^https:\/\/storage\.test\/.+\/menu\/.+\/thumb-[0-9a-f-]+\.webp\?/,
      );
      expect(lifeOf(item?.photoUrl)).toBe('3600');
      expect(lifeOf(item?.thumbUrl)).toBe('3600');
      expect(item?.photoAlt).toBe('A plate');
      expect(response.text).not.toContain('gs://');

      // A photo stored before thumbnails: the photo, and no thumbnail yet.
      await prisma.menuItem.update({
        where: { id: dish.id },
        data: { photoThumb: null },
      });

      const older = findItem(await menu(), dish.slug);

      expect(older?.photoUrl).toBe(item?.photoUrl);
      expect(older?.thumbUrl).toBeNull();
    });
  });

  describe('GET /business and GET /opening-hours', () => {
    it('answers the business details without the row’s internals', async () => {
      const response = await get('/business').expect(200);

      expect(response.headers['cache-control']).toBe('public, max-age=60');
      expect(Object.keys(response.body as object).sort()).toEqual(
        [
          'addressLine',
          'addressLines',
          'email',
          'mapLat',
          'mapLng',
          'name',
          'phone',
          'registration',
          'socialLinks',
        ].sort(),
      );
      expect(response.body).toMatchObject({ name: 'Chef Noro Culinary' });
    });

    it('answers the week in TAY’s shape', async () => {
      const response = await get('/opening-hours').expect(200);
      const body = response.body as {
        isSet: boolean;
        days: { dayOfWeek: number; opensAtMinutes: number | null }[];
      };

      expect(response.headers['cache-control']).toBe('public, max-age=60');
      expect(body.isSet).toBe(true);
      expect(body.days.map((day) => day.dayOfWeek)).toEqual([
        0, 1, 2, 3, 4, 5, 6,
      ]);
    });
  });

  describe('GET /venues', () => {
    it('lists the rooms and their tables in use, and nothing else', async () => {
      const extra = await prisma.diningTable.create({
        data: {
          venueId: (
            await prisma.venue.findUniqueOrThrow({ where: { slug: 'dining' } })
          ).id,
          code: 'OUT1',
          name: 'Out of use',
          kind: TableKind.DINING,
          capacity: 2,
          active: false,
        },
      });

      const response = await get('/venues').expect(200);
      const body = response.body as {
        venues: {
          slug: string;
          title: string;
          bigParty: number;
          tables: Record<string, unknown>[];
        }[];
      };

      expect(response.headers['cache-control']).toBe('public, max-age=60');
      expect(
        body.venues.map((venue) => [venue.slug, venue.title, venue.bigParty]),
      ).toEqual([
        ['dining', 'Dining', 4],
        ['lounge', 'Lounge', 5],
      ]);

      const active = await prisma.diningTable.count({
        where: { active: true },
      });
      const tables = body.venues.flatMap((venue) => venue.tables);
      expect(tables).toHaveLength(active);
      expect(tables.map((table) => table.code)).not.toContain(extra.code);
      for (const table of tables) {
        expect(Object.keys(table).sort()).toEqual(
          ['capacity', 'code', 'kind', 'name'].sort(),
        );
      }
      expect(response.text).not.toContain('Diner');
    });
  });

  describe('GET /venues/:venue/availability', () => {
    const availability = async (venue: string, date?: string) => {
      const call = get(`/venues/${venue}/availability`);
      const response = await (
        date === undefined ? call : call.query({ date })
      ).expect(200);

      expect(response.headers['cache-control']).toBe('no-store');

      return response.body as AvailabilityBody;
    };
    const statusOf = (body: AvailabilityBody, code: string) =>
      body.tables.find((table) => table.code === code)?.status;
    const tableId = async (venue: string, code: string) =>
      (
        await prisma.diningTable.findFirstOrThrow({
          where: { code, venue: { slug: venue } },
          select: { id: true },
        })
      ).id;

    it('shows today’s remaining arrival times, from 12:30 at noon to 23:00', async () => {
      const body = await availability('dining');

      expect(body.venue).toBe('dining');
      expect(body.date).toBe(dayFromToday(0));
      expect(body.arrivalTimes[0]).toBe('12:30');
      expect(body.arrivalTimes[body.arrivalTimes.length - 1]).toBe('23:00');
      expect(body.tables.every((table) => table.status === 'AVAILABLE')).toBe(
        true,
      );
      expect(Object.keys(body.tables[0]).sort()).toEqual(['code', 'status']);
    });

    it('shows a booked table RESERVED on its date only, without the guest', async () => {
      const b1 = await tableId('dining', 'B1');

      await request(server())
        .post('/api/v1/staff/reservations')
        .set(await asStaff(receptionId))
        .set('Idempotency-Key', randomUUID())
        .send({
          name: 'Private Guest',
          phone: '08031234567',
          email: 'private.guest@example.com',
          tableId: b1,
          party: 2,
          businessDate: dayFromToday(1),
          time: '19:00',
        })
        .expect(201);

      const tomorrow = await availability('dining', dayFromToday(1));
      expect(statusOf(tomorrow, 'B1')).toBe('RESERVED');
      expect(tomorrow.arrivalTimes[0]).toBe('08:00');
      expect(JSON.stringify(tomorrow)).not.toContain('Private Guest');
      expect(JSON.stringify(tomorrow)).not.toContain('08031234567');

      expect(statusOf(await availability('dining'), 'B1')).toBe('AVAILABLE');
    });

    it('shows seated guests OCCUPIED today only, and free again once Reception releases the table (gate step 4)', async () => {
      const ts1 = await tableId('lounge', 'TS1');
      const seated = await request(server())
        .post(`/api/v1/staff/tables/${ts1}/allocate`)
        .set(await asStaff(receptionId))
        .send({ status: 'OCCUPIED', guest: 'Walk in', party: 2 })
        .expect(201);
      const session = seated.body as { id: string; version: number };

      expect(statusOf(await availability('lounge'), 'TS1')).toBe('OCCUPIED');
      expect(
        statusOf(await availability('lounge', dayFromToday(1)), 'TS1'),
      ).toBe('AVAILABLE');

      await request(server())
        .post(`/api/v1/staff/tables/${ts1}/release`)
        .set(await asStaff(receptionId))
        .send({ sessionId: session.id, version: session.version })
        .expect(200);

      expect(statusOf(await availability('lounge'), 'TS1')).toBe('AVAILABLE');
    });

    it('shows a locked table BLOCKED, without the reason', async () => {
      const ts2 = await tableId('lounge', 'TS2');

      await request(server())
        .post(`/api/v1/staff/tables/${ts2}/allocate`)
        .set(await asStaff(receptionId))
        .send({ status: 'LOCKED', note: 'Broken chair being fixed' })
        .expect(201);

      const body = await availability('lounge');
      expect(statusOf(body, 'TS2')).toBe('BLOCKED');
      expect(JSON.stringify(body)).not.toContain('Broken chair');
    });

    it('offers no arrival time on a day the hours mark closed', async () => {
      const date = addDays(watToday(new Date()), 2);
      const dayOfWeek = date.getUTCDay();
      const before = await prisma.openingHoursDay.findUniqueOrThrow({
        where: { dayOfWeek },
      });

      await prisma.openingHoursDay.update({
        where: { dayOfWeek },
        data: { isClosed: true, opensAtMinutes: null, closesAtMinutes: null },
      });

      try {
        expect(
          (await availability('dining', formatIsoDate(date))).arrivalTimes,
        ).toEqual([]);
      } finally {
        await prisma.openingHoursDay.update({
          where: { dayOfWeek },
          data: {
            isClosed: before.isClosed,
            opensAtMinutes: before.opensAtMinutes,
            closesAtMinutes: before.closesAtMinutes,
          },
        });
      }
    });

    it('refuses a past date, a malformed date and an unknown room', async () => {
      const past = await get('/venues/dining/availability')
        .query({ date: dayFromToday(-1) })
        .expect(400);
      expect(messageOf(past)).toBe(PAST_DATE_MESSAGE);

      const bad = await get('/venues/dining/availability')
        .query({ date: '2026-02-30' })
        .expect(400);
      expect(messageOf(bad)).toEqual([RESERVATION_DATE_MESSAGE]);

      const missing = await get('/venues/rooftop/availability').expect(404);
      expect(messageOf(missing)).toBe(VENUE_NOT_FOUND_MESSAGE);
    });
  });

  describe('GET /ordering/config and /ordering/slots', () => {
    const slots = async (query: Record<string, string>) => {
      const response = await get('/ordering/slots').query(query).expect(200);

      expect(response.headers['cache-control']).toBe('no-store');

      return response.body as SlotsBody;
    };

    it('answers VAT, the zones, the lead times and the grid, and no other setting', async () => {
      const response = await get('/ordering/config').expect(200);

      expect(response.headers['cache-control']).toBe('public, max-age=60');
      expect(response.body).toEqual({
        vatBps: 750,
        pickup: { leadMinutes: 60 },
        zones: [
          { zone: 'JOS', feeKobo: 500000, leadMinutes: 90 },
          { zone: 'PLATEAU', feeKobo: 1000000, leadMinutes: 120 },
        ],
        slotStepMinutes: 30,
        lastOrderSlot: '23:30',
      });
      expect(response.text).not.toContain('approval');
    });

    it('at noon offers ASAP and today’s slots from now plus the lead', async () => {
      const pickup = await slots({ fulfilment: 'PICKUP' });

      expect(pickup.asap).toBe(true);
      expect(pickup.leadMinutes).toBe(60);
      expect(pickup.todayDate).toBe(dayFromToday(0));
      expect(pickup.today[0]).toBe('13:00');
      expect(pickup.today[pickup.today.length - 1]).toBe('23:30');
      expect(pickup.tomorrowDate).toBe(dayFromToday(1));
      expect(pickup.tomorrow[0]).toBe('08:00');
      expect(pickup.tomorrow).toHaveLength(32);

      const jos = await slots({ fulfilment: 'DELIVERY', zone: 'JOS' });
      expect(jos.leadMinutes).toBe(90);
      expect(jos.today[0]).toBe('13:30');

      const plateau = await slots({ fulfilment: 'DELIVERY', zone: 'PLATEAU' });
      expect(plateau.leadMinutes).toBe(120);
      expect(plateau.today[0]).toBe('14:00');
    });

    it('ignores the zone for pickup and refuses a delivery without one', async () => {
      expect(
        (await slots({ fulfilment: 'PICKUP', zone: 'PLATEAU' })).leadMinutes,
      ).toBe(60);

      const noZone = await get('/ordering/slots')
        .query({ fulfilment: 'DELIVERY' })
        .expect(400);
      expect(messageOf(noZone)).toEqual([DELIVERY_ZONE_MESSAGE]);

      const badFulfilment = await get('/ordering/slots')
        .query({ fulfilment: 'DRONE' })
        .expect(400);
      expect(messageOf(badFulfilment)).toEqual([FULFILMENT_MESSAGE]);
    });

    it('late in the evening closes ASAP for a delivery that would arrive after 23:30', async () => {
      // 22:30 in Jos.
      jest.setSystemTime(noon + 10.5 * HOUR);

      const jos = await slots({ fulfilment: 'DELIVERY', zone: 'JOS' });
      expect(jos.asap).toBe(false);
      expect(jos.today).toEqual([]);
      expect(jos.tomorrow[0]).toBe('08:00');

      const pickup = await slots({ fulfilment: 'PICKUP' });
      expect(pickup.asap).toBe(true);
      expect(pickup.today).toEqual(['23:30']);
    });
  });
});
