import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrinterWidth, StaffRole } from '../generated/cnc-client';
import { BUSINESS } from '../prisma/seed-data/reference';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { CncConfigService } from '../src/config/cnc.config';
import {
  OWNER_ONLY_SETTINGS_MESSAGE,
  OWNER_ONLY_TIMES_MESSAGE,
} from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import {
  BUSINESS_EMAIL_MESSAGE,
  BUSINESS_PHONE_MESSAGE,
  BUSINESS_REQUIRED_MESSAGE,
  DAILY_LIMIT_SWITCH_MESSAGE,
  PRINTER_WIDTH_MESSAGE,
  SETTINGS_NUMBERS_MESSAGE,
  SETTINGS_RANGES_MESSAGE,
} from '../src/settings/settings-rules';
import { createTestApp } from './create-test-app';
import { lockSharedRows } from './shared-rows-lock';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * Settings, business details and opening hours (C3-7) through HTTP and
 * against Postgres: who may change which key, the demo's sentences, the
 * version check, and the audit row.
 *
 * These are one-row tables every suite shares, and the routes commit. So
 * the suite holds the shared-rows lock throughout (the seed suite asserts
 * on the same rows), never touches the approval limits other suites read,
 * and puts back every value it changes in `afterAll`, whatever happened.
 */
describe('Settings (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let unlock: () => Promise<void>;

  let ownerToken: string;
  let managerToken: string;
  let cashierToken: string;

  /** The rows as they were, to put back. */
  let originalSettings: {
    vatBps: number;
    leadPickupMinutes: number;
    printerWidth: PrinterWidth;
    alertArrivals: boolean;
  };
  let originalBusiness: {
    phone: string;
    email: string;
    registration: string;
  };
  let originalWeek: {
    dayOfWeek: number;
    isClosed: boolean;
    opensAtMinutes: number | null;
    closesAtMinutes: number | null;
  }[];

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    unlock = await lockSharedRows(app.get(CncConfigService).databaseUrl);

    // The rows a seeded database holds, created if this one was never
    // seeded (a fresh CI database); never changed if present.
    await prisma.settings.createMany({ data: [{}], skipDuplicates: true });
    await prisma.business.createMany({
      data: [{ ...BUSINESS, addressLines: [...BUSINESS.addressLines] }],
      skipDuplicates: true,
    });

    originalSettings = await prisma.settings.findUniqueOrThrow({
      where: { singleton: true },
      select: {
        vatBps: true,
        leadPickupMinutes: true,
        printerWidth: true,
        alertArrivals: true,
      },
    });
    originalBusiness = await prisma.business.findUniqueOrThrow({
      where: { singleton: true },
      select: { phone: true, email: true, registration: true },
    });
    originalWeek = await prisma.openingHoursDay.findMany({
      orderBy: { dayOfWeek: 'asc' },
      select: {
        dayOfWeek: true,
        isClosed: true,
        opensAtMinutes: true,
        closesAtMinutes: true,
      },
    });

    const tokens = app.get(CncTokenService, { strict: false });
    const token = async (role: StaffRole) =>
      accessTokenFor(
        tokens,
        (
          await createStaffAccount(prisma, role, {
            emailPrefix: 'settings',
            name: `Settings ${role.toLowerCase()}`,
          })
        ).id,
      );

    ownerToken = await token(StaffRole.OWNER);
    managerToken = await token(StaffRole.MANAGER);
    cashierToken = await token(StaffRole.CASHIER);
  });

  afterAll(async () => {
    try {
      await prisma.settings.update({
        where: { singleton: true },
        data: originalSettings,
      });
      await prisma.business.update({
        where: { singleton: true },
        data: originalBusiness,
      });
      await prisma.$transaction(async (tx) => {
        await tx.openingHoursDay.deleteMany({});
        await tx.openingHoursDay.createMany({ data: originalWeek });
      });
    } finally {
      await unlock();
      await app.close();
    }
  });

  const server = () => app.getHttpServer();
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  const settingsVersion = async () =>
    (
      await prisma.settings.findUniqueOrThrow({
        where: { singleton: true },
        select: { version: true },
      })
    ).version;

  const businessVersion = async () =>
    (
      await prisma.business.findUniqueOrThrow({
        where: { singleton: true },
        select: { version: true },
      })
    ).version;

  /** A settings save naming the current version, expecting `status`. */
  const saveSettings = async (
    token: string,
    body: Record<string, unknown>,
    status: number,
  ) =>
    request(server())
      .patch('/api/v1/staff/settings')
      .set(auth(token))
      .send({ version: await settingsVersion(), ...body })
      .expect(status);

  /** A business save naming the current version, expecting `status`. */
  const saveBusiness = async (
    token: string,
    body: Record<string, unknown>,
    status: number,
  ) =>
    request(server())
      .patch('/api/v1/staff/business')
      .set(auth(token))
      .send({ version: await businessVersion(), ...body })
      .expect(status);

  describe('reading', () => {
    it('answers the settings, business and week to managers, each with its version', async () => {
      const response = await request(server())
        .get('/api/v1/staff/settings')
        .set(auth(managerToken))
        .expect(200);
      const body = response.body as {
        settings: Record<string, unknown>;
        business: Record<string, unknown>;
        openingHours: { isSet: boolean; days: unknown[] };
      };

      expect(Object.keys(body).sort()).toEqual([
        'business',
        'openingHours',
        'settings',
      ]);
      expect(body.settings).toMatchObject({
        version: await settingsVersion(),
      });
      expect(body.settings).not.toHaveProperty('id');
      expect(body.settings).not.toHaveProperty('singleton');
      expect(body.business.version).toBe(await businessVersion());
      expect(body.openingHours.isSet).toBe(true);
      expect(body.openingHours.days).toHaveLength(7);
    });

    it('refuses everyone but managers', async () => {
      const response = await request(server())
        .get('/api/v1/staff/settings')
        .set(auth(cashierToken))
        .expect(403);

      expect(messageOf(response)).toBe(ROLE_REFUSED_MESSAGE);
    });
  });

  describe('settings.save', () => {
    it('lets a manager change the printer and an alert, and moves the version', async () => {
      const version = await settingsVersion();

      const response = await saveSettings(
        managerToken,
        {
          printerWidth: PrinterWidth.MM58,
          alertArrivals: !originalSettings.alertArrivals,
        },
        200,
      );

      expect(response.body).toMatchObject({
        printerWidth: PrinterWidth.MM58,
        alertArrivals: !originalSettings.alertArrivals,
        version: version + 1,
      });
    });

    it('refuses a manager changing VAT or a limit, with the demo’s sentence', async () => {
      for (const body of [
        { vatBps: originalSettings.vatBps + 50 },
        { approvalLimitKobo: 1 },
        { dailyLimitOn: false },
        { deliveryJosKobo: 1 },
      ]) {
        const response = await saveSettings(managerToken, body, 403);
        expect(messageOf(response)).toBe(OWNER_ONLY_SETTINGS_MESSAGE);
      }
    });

    it('refuses a manager changing a booking or ordering time (Q29)', async () => {
      const response = await saveSettings(
        managerToken,
        { leadPickupMinutes: originalSettings.leadPickupMinutes + 5 },
        403,
      );

      expect(messageOf(response)).toBe(OWNER_ONLY_TIMES_MESSAGE);
    });

    it('lets a manager send VAT unchanged with the rest of the form', async () => {
      await saveSettings(
        managerToken,
        {
          vatBps: originalSettings.vatBps,
          leadPickupMinutes: originalSettings.leadPickupMinutes,
          printerWidth: PrinterWidth.A4,
        },
        200,
      );
    });

    it('lets the Owner change VAT and a lead time, and records the change in sentences', async () => {
      await saveSettings(
        ownerToken,
        {
          vatBps: 800,
          leadPickupMinutes: originalSettings.leadPickupMinutes + 5,
        },
        200,
      );

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'settings.save' },
        orderBy: { at: 'desc' },
      });
      const history = await request(server())
        .get('/api/v1/staff/audit')
        .query({ action: 'settings.save', pageSize: 1 })
        .set(auth(ownerToken))
        .expect(200);
      const [row] = (
        history.body as { data: { id: string; changes: string[] }[] }
      ).data;

      expect(row.id).toBe(entry.id);
      expect(row.changes).toEqual(
        expect.arrayContaining([
          `VAT changed from ${originalSettings.vatBps / 100}% to 8%.`,
        ]),
      );
    });

    it('answers out-of-range values in the demo’s words', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ vatBps: 10001 }, SETTINGS_RANGES_MESSAGE],
        [{ freeTableReminderMinutes: 10 }, SETTINGS_RANGES_MESSAGE],
        [{ freeTableReminderMinutes: 1.5 }, SETTINGS_NUMBERS_MESSAGE],
        [{ deliveryJosKobo: -1 }, SETTINGS_NUMBERS_MESSAGE],
        [{ printerWidth: '110mm' }, PRINTER_WIDTH_MESSAGE],
        [{ dailyLimitOn: 'yes' }, DAILY_LIMIT_SWITCH_MESSAGE],
      ];

      for (const [body, message] of cases) {
        const response = await saveSettings(ownerToken, body, 400);
        expect(messageOf(response)).toContain(message);
      }
    });

    it('answers a stale version with 409', async () => {
      const response = await request(server())
        .patch('/api/v1/staff/settings')
        .set(auth(managerToken))
        .send({ version: (await settingsVersion()) - 1, printerWidth: 'MM80' })
        .expect(409);

      expect(messageOf(response)).toBe(STALE_VERSION_MESSAGE);
    });
  });

  describe('business details', () => {
    it('lets a manager change them, storing the phone as digits', async () => {
      const response = await saveBusiness(
        managerToken,
        {
          phone: '+234 802 218 8797',
          email: '',
          registration: `RC ${randomUUID().slice(0, 6)}`,
        },
        200,
      );

      expect(response.body).toMatchObject({ phone: '08022188797', email: '' });
    });

    it('never lets the name, the address or the phone end up blank', async () => {
      for (const body of [
        { name: '  ' },
        { addressLine: '' },
        { addressLines: [] },
        { phone: '' },
      ]) {
        const response = await saveBusiness(managerToken, body, 400);
        expect(messageOf(response)).toContain(BUSINESS_REQUIRED_MESSAGE);
      }
    });

    it('refuses a bad email and a phone that is not Nigerian', async () => {
      const email = await saveBusiness(
        managerToken,
        { email: 'cnc at gmail' },
        400,
      );
      expect(messageOf(email)).toContain(BUSINESS_EMAIL_MESSAGE);

      const phone = await saveBusiness(
        managerToken,
        { phone: '+44 20 7946 0958' },
        400,
      );
      expect(messageOf(phone)).toContain(BUSINESS_PHONE_MESSAGE);
    });

    it('is audited as settings.save', async () => {
      await saveBusiness(managerToken, { registration: 'RC 765598' }, 200);

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'settings.save' },
        orderBy: { at: 'desc' },
      });
      expect(entry.after).toMatchObject({ registration: 'RC 765598' });
    });
  });

  describe('opening hours', () => {
    const week = (mondayClosed: boolean) =>
      [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) =>
        dayOfWeek === 1 && mondayClosed
          ? { dayOfWeek, isClosed: true, opensAtMinutes: null }
          : {
              dayOfWeek,
              isClosed: false,
              opensAtMinutes: 480,
              closesAtMinutes: 1440,
            },
      );

    const put = (token: string, days: unknown) =>
      request(server())
        .put('/api/v1/staff/opening-hours')
        .set(auth(token))
        .send({ days });

    it('keeps the week for the Owner (Q29)', async () => {
      const manager = await put(managerToken, week(true)).expect(403);
      expect(messageOf(manager)).toBe(OWNER_ONLY_TIMES_MESSAGE);

      const cashier = await put(cashierToken, week(true)).expect(403);
      expect(messageOf(cashier)).toBe(ROLE_REFUSED_MESSAGE);
    });

    it('replaces the week for the Owner, and records the day that changed', async () => {
      await put(ownerToken, week(false)).expect(200);

      const response = await put(ownerToken, week(true)).expect(200);
      const body = response.body as {
        isSet: boolean;
        days: { dayOfWeek: number; isClosed: boolean }[];
      };

      expect(body.isSet).toBe(true);
      expect(body.days[1]).toEqual({
        dayOfWeek: 1,
        isClosed: true,
        opensAtMinutes: null,
        closesAtMinutes: null,
      });

      const history = await request(server())
        .get('/api/v1/staff/audit')
        .query({ action: 'settings.openingHours', pageSize: 1 })
        .set(auth(ownerToken))
        .expect(200);
      const [row] = (
        history.body as { data: { actionLabel: string; changes: string[] }[] }
      ).data;

      expect(row).toEqual(
        expect.objectContaining({
          actionLabel: 'Opening Hours Saved',
          changes: ['Monday changed from 08:00–24:00 to Closed.'],
        }),
      );
    });

    it('refuses a closed day with a time, and a week that is not seven days', async () => {
      const closedWithTime = week(true).map((day) =>
        day.dayOfWeek === 1 ? { ...day, opensAtMinutes: 480 } : day,
      );

      const response = await put(ownerToken, closedWithTime).expect(400);
      expect(messageOf(response)).toContain(
        'Monday is closed, so it takes no opening or closing time.',
      );

      await put(ownerToken, week(false).slice(1)).expect(400);
    });
  });
});
