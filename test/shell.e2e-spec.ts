import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { StaffRole } from '../generated/cnc-client';
import { BUSINESS } from '../prisma/seed-data/reference';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { PASSWORD_CHANGE_REQUIRED_MESSAGE } from '../src/auth/guards/cnc-staff.guard';
import { formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { presetWidgets } from '../src/shell/overview-preferences';
import { STAFF_PAGES } from '../src/shell/staff-pages';
import { createTestApp } from './create-test-app';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * The staff shell (C3-8) through HTTP and against Postgres: `GET /staff/me`
 * (open during a forced password change), `GET /staff/reference`, and the
 * overview layout saved per person.
 */
describe('staff shell (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });

    // The one-row tables a seeded database holds, created if this one was
    // never seeded; never changed if present.
    await prisma.settings.createMany({ data: [{}], skipDuplicates: true });
    await prisma.business.createMany({
      data: [{ ...BUSINESS, addressLines: [...BUSINESS.addressLines] }],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const today = () => formatIsoDate(watToday(new Date()));

  async function signedIn(
    role: StaffRole,
    options: { mustChangePassword?: boolean } = {},
  ) {
    const account = await createStaffAccount(prisma, role, {
      emailPrefix: 'shell',
      name: `Shell ${role.toLowerCase()}`,
      mustChangePassword: options.mustChangePassword,
    });

    return {
      ...account,
      headers: {
        Authorization: `Bearer ${await accessTokenFor(tokens, account.id)}`,
      },
    };
  }

  describe('GET /staff/me', () => {
    it('answers who is signed in and the screens their role may open', async () => {
      const cashier = await signedIn(StaffRole.CASHIER);

      const response = await request(server())
        .get('/api/v1/staff/me')
        .set(cashier.headers)
        .expect(200);

      expect(response.body).toEqual({
        id: cashier.id,
        staffNo: cashier.staffNo,
        name: cashier.name,
        email: cashier.email,
        role: StaffRole.CASHIER,
        mustChangePassword: false,
        pages: ['overview', 'pos', 'online', 'reports', 'tasks', 'myid'],
        photoUrl: null,
        joinedOn: today(),
        version: 0,
      });
    });

    it('opens every screen to a manager', async () => {
      const manager = await signedIn(StaffRole.MANAGER);

      const response = await request(server())
        .get('/api/v1/staff/me')
        .set(manager.headers)
        .expect(200);

      expect((response.body as { pages: string[] }).pages).toEqual([
        ...STAFF_PAGES,
      ]);
    });

    it('answers during a forced password change, while other shell routes refuse', async () => {
      const fresh = await signedIn(StaffRole.WAITER, {
        mustChangePassword: true,
      });

      const me = await request(server())
        .get('/api/v1/staff/me')
        .set(fresh.headers)
        .expect(200);
      expect(
        (me.body as { mustChangePassword: boolean }).mustChangePassword,
      ).toBe(true);

      const reference = await request(server())
        .get('/api/v1/staff/reference')
        .set(fresh.headers)
        .expect(403);
      expect((reference.body as { message: string }).message).toBe(
        PASSWORD_CHANGE_REQUIRED_MESSAGE,
      );
    });

    it('needs a token', async () => {
      await request(server()).get('/api/v1/staff/me').expect(401);
    });
  });

  describe('GET /staff/reference', () => {
    it('answers every part to any staff role, without credentials or colleagues’ emails', async () => {
      const waiter = await signedIn(StaffRole.WAITER);

      const response = await request(server())
        .get('/api/v1/staff/reference')
        .set(waiter.headers)
        .expect(200);
      const body = response.body as {
        settings: { vatBps: number; version: number };
        business: { name: string };
        openingHours: { days: unknown[] };
        venues: { tables: unknown[] }[];
        menuCategories: unknown[];
        staffCategories: unknown[];
        menu: { photoUrl: string | null }[];
        stockItems: unknown[];
        staff: Record<string, unknown>[];
      };

      expect(Object.keys(body).sort()).toEqual([
        'business',
        'kitchenMappings',
        'menu',
        'menuCategories',
        'openingHours',
        'settings',
        'staff',
        'staffCategories',
        'stockItems',
        'vendors',
        'venues',
      ]);
      expect(body.settings.vatBps).toEqual(expect.any(Number));
      expect(body.openingHours.days).toHaveLength(7);

      const me = body.staff.find((row) => row.id === waiter.id);
      expect(me).toEqual({
        id: waiter.id,
        staffNo: waiter.staffNo,
        name: waiter.name,
        role: StaffRole.WAITER,
        isActive: true,
      });

      const text = JSON.stringify(response.body);
      expect(text).not.toContain('passwordHash');
      expect(text).not.toContain('qrToken');
      expect(text).not.toContain(waiter.email);
      expect(text).not.toContain('gs://');
    });
  });

  describe('the overview layout', () => {
    const path = '/api/v1/staff/me/preferences/overview';

    it('answers the Service preset for today until one is saved', async () => {
      const manager = await signedIn(StaffRole.MANAGER);

      const response = await request(server())
        .get(path)
        .set(manager.headers)
        .expect(200);

      expect(response.body).toEqual({
        version: 1,
        widgets: presetWidgets('Service'),
        period: 'Today',
        from: today(),
        to: today(),
      });
    });

    it('saves a layout per person, made whole, without moving the account’s version', async () => {
      const manager = await signedIn(StaffRole.MANAGER);
      const layout = {
        version: 1,
        widgets: [
          { id: 'trend', visible: true, wide: true },
          { id: 'sales', visible: true, wide: false },
        ],
        period: 'Custom',
        from: '2026-09-01',
        to: '2026-09-30',
      };

      const saved = await request(server())
        .put(path)
        .set(manager.headers)
        .send(layout)
        .expect(200);
      const read = await request(server())
        .get(path)
        .set(manager.headers)
        .expect(200);

      expect(read.body).toEqual(saved.body);
      const body = read.body as {
        widgets: { id: string; visible: boolean }[];
        period: string;
      };
      expect(body.widgets.slice(0, 2)).toEqual(layout.widgets);
      expect(body.widgets).toHaveLength(14);
      expect(body.widgets.slice(2).every((widget) => !widget.visible)).toBe(
        true,
      );
      expect(body.period).toBe('Custom');

      const row = await prisma.staff.findUniqueOrThrow({
        where: { id: manager.id },
      });
      expect(row.version).toBe(0);

      const other = await signedIn(StaffRole.MANAGER);
      const theirs = await request(server())
        .get(path)
        .set(other.headers)
        .expect(200);
      expect((theirs.body as { period: string }).period).toBe('Today');
    });

    it('refuses an unknown widget, a layout showing nothing, and a date that does not exist', async () => {
      const manager = await signedIn(StaffRole.MANAGER);
      const base = {
        version: 1,
        widgets: [{ id: 'sales', visible: true, wide: false }],
        period: 'Today',
        from: '2026-10-01',
        to: '2026-10-01',
      };

      for (const body of [
        { ...base, widgets: [{ id: 'weather', visible: true, wide: false }] },
        { ...base, widgets: [{ id: 'sales', visible: false, wide: false }] },
        { ...base, from: '2026-02-30' },
      ]) {
        await request(server())
          .put(path)
          .set(manager.headers)
          .send(body)
          .expect(400);
      }
    });
  });
});
