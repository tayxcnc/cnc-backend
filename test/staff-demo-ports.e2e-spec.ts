import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  PrinterWidth,
  StaffRole,
  SubjectType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { STAFF_REFRESH_COOKIE } from '../src/auth/refresh-cookie';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { MENU_NAME_PRICE_MESSAGE } from '../src/menu/menu-messages';
import {
  LAST_ACTIVE_OWNER_MESSAGE,
  OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE,
  OWNER_ONLY_NEW_MENU_ITEM_MESSAGE,
  OWNER_ONLY_PRICE_MESSAGE,
  OWNER_ONLY_SETTINGS_MESSAGE,
} from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import {
  SETTINGS_NUMBERS_MESSAGE,
  SETTINGS_RANGES_MESSAGE,
} from '../src/settings/settings-rules';
import {
  OWN_PHOTO_ONLY_MESSAGE,
  STAFF_EMAIL_REASON_MESSAGE,
  STAFF_EMAIL_TAKEN_MESSAGE,
  STAFF_NAME_AND_ROLE_MESSAGE,
} from '../src/staff/staff-messages';
import { createTestApp } from './create-test-app';
import {
  type IsolatedDatabase,
  createIsolatedDatabase,
} from './isolated-database';
import {
  type StaffAccount,
  accessTokenFor,
  createStaffAccount,
} from './staff-fixtures';
import { clientAddress } from './staff-sessions';
import { testImage } from './test-images';

/**
 * C3-10: the staff app's `owner.test.cjs`, `revision.test.cjs` and
 * `ux.test.cjs`, ported for the commands that exist on the server after C3
 * (`staff.save`, `staff.photo`, `menu.save`, `settings.save`, the audit
 * read and the page list). Each test keeps the demo test's title and its
 * expectations, through HTTP and Postgres instead of `execute()`.
 *
 * The demo tests act on one shared state with one Owner and assert on
 * whole-state facts ("one Owner always remains", "no other audit entry
 * changed"), so this file runs on a database of its own, seeded with the
 * real data seed and holding exactly one Owner. The actors are the demo's
 * named ones. Tests run in file order and build on each other's state, as
 * the demo's did within a test.
 *
 * Demo tests for commands that arrive later (order.reverse, stock.adjust,
 * discounts, purchases, waste, requests, online corrections, kitchen,
 * tasks, attendance) are ported with those commands (C4-9, C5-8), and the
 * browser-storage tests in `ux.test.cjs` have no server counterpart.
 */
describe('staff app specs, ported (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  const originalUrl = process.env.CNC_DB_URL;

  interface Actor extends StaffAccount {
    token: string;
  }

  type ActorName =
    | 'owner'
    | 'manager'
    | 'manager2'
    | 'store'
    | 'bar'
    | 'cashier'
    | 'waiter'
    | 'reception';

  /** The demo's named actors (`owner.test.cjs`, `A`), plus two more roles. */
  const A = {} as Record<ActorName, Actor>;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);

    const named: [ActorName, StaffRole, string][] = [
      ['owner', StaffRole.OWNER, 'Test Owner'],
      ['manager', StaffRole.MANAGER, 'Test Manager'],
      ['manager2', StaffRole.MANAGER, 'Other Manager'],
      ['store', StaffRole.STOREKEEPER, 'Test Store'],
      ['bar', StaffRole.BARTENDER, 'Test Bar'],
      ['cashier', StaffRole.CASHIER, 'Test Cashier'],
      ['waiter', StaffRole.WAITER, 'Test Waiter'],
      ['reception', StaffRole.RECEPTION, 'Test Reception'],
    ];

    for (const [key, role, name] of named) {
      const account = await createStaffAccount(prisma, role, {
        emailPrefix: key,
        name,
      });

      A[key] = { ...account, token: await accessTokenFor(tokens, account.id) };
    }
  }, 120_000);

  afterAll(async () => {
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const as = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` });
  /** A service refusal is a sentence; a validation refusal is a list. */
  const messagesOf = (response: request.Response): unknown[] =>
    [(response.body as { message: unknown }).message].flat();
  const only = /Only the Owner/;

  // ------------------------------------------------------------- helpers
  //
  // The versioned writes read the record's current version first, as the
  // app does after loading the screen, and take the status they expect.

  interface Settings {
    version: number;
    approvalLimitKobo: number;
    dailyLimitOn: boolean;
    dailyLimitKobo: number;
    printerWidth: PrinterWidth;
    freeTableReminderMinutes: number;
    serviceBps: number;
  }

  async function settings(): Promise<Settings> {
    const response = await request(server())
      .get('/api/v1/staff/settings')
      .set(as(A.owner))
      .expect(200);

    return (response.body as { settings: Settings }).settings;
  }

  async function saveSettings(
    by: Actor,
    changes: object,
    status: number,
  ): Promise<request.Response> {
    const { version } = await settings();

    return request(server())
      .patch('/api/v1/staff/settings')
      .set(as(by))
      .send({ version, ...changes })
      .expect(status);
  }

  interface MenuItem {
    id: string;
    priceKobo: number;
    showOnline: boolean;
    version: number;
  }

  async function restaurantMenu(by: Actor): Promise<MenuItem[]> {
    const response = await request(server())
      .get('/api/v1/staff/menu')
      .query({ pageSize: 100, department: Department.RESTAURANT })
      .set(as(by))
      .expect(200);

    return (response.body as { data: MenuItem[] }).data;
  }

  async function menuItem(id: string): Promise<MenuItem> {
    const item = (await restaurantMenu(A.owner)).find((row) => row.id === id);

    if (item === undefined) throw new Error(`No menu item ${id}.`);

    return item;
  }

  async function saveItem(
    by: Actor,
    id: string,
    changes: object,
    status: number,
  ): Promise<request.Response> {
    const { version } = await menuItem(id);

    return request(server())
      .patch(`/api/v1/staff/menu/${id}`)
      .set(as(by))
      .send({ version, ...changes })
      .expect(status);
  }

  const addItem = (by: Actor, body: object) =>
    request(server())
      .post('/api/v1/staff/menu')
      .set(as(by))
      .set('Idempotency-Key', randomUUID())
      .send(body);

  async function versionOf(id: string): Promise<number> {
    const row = await prisma.staff.findUniqueOrThrow({
      where: { id },
      select: { version: true },
    });

    return row.version;
  }

  const createPerson = (by: Actor, body: object) =>
    request(server()).post('/api/v1/staff/people').set(as(by)).send(body);

  const hire = (by: Actor, role: StaffRole, email: string) =>
    createPerson(by, { name: 'New Person', role, email });

  async function saveStaff(
    by: Actor,
    id: string,
    changes: object,
    status: number,
  ): Promise<request.Response> {
    const version = await versionOf(id);

    return request(server())
      .patch(`/api/v1/staff/people/${id}`)
      .set(as(by))
      .send({ version, ...changes })
      .expect(status);
  }

  async function uploadPhoto(
    by: Actor,
    id: string,
    status: number,
  ): Promise<request.Response> {
    const version = await versionOf(id);
    const photo = await testImage(400, 400);

    return request(server())
      .post(`/api/v1/staff/people/${id}/photo`)
      .set(as(by))
      .field('version', String(version))
      .attach('photo', photo, 'face.jpg')
      .expect(status);
  }

  const auditAs = (by: Actor) =>
    request(server())
      .get('/api/v1/staff/audit')
      .query({ pageSize: 100 })
      .set(as(by));

  // -------------------------------------------------------- owner.test.cjs

  describe('owner.test.cjs', () => {
    it('the Owner Approval Limit defaults to 50,000 naira and old saved records fall back to it', async () => {
      // There are no old saved records on the server: the column has the
      // default, and the seed writes it.
      expect((await settings()).approvalLimitKobo).toBe(5_000_000);
    });

    it('a manager cannot set or change a price or add an item, but can still edit everything else', async () => {
      const [item] = await restaurantMenu(A.manager);
      const category = await prisma.staffCategory.findFirstOrThrow({
        where: { department: Department.RESTAURANT },
        orderBy: { name: 'asc' },
      });
      const newDish = {
        name: 'New Dish',
        priceKobo: 100_000,
        department: Department.RESTAURANT,
        staffCategoryId: category.id,
      };

      const price = await saveItem(
        A.manager,
        item.id,
        { priceKobo: item.priceKobo - 100 },
        403,
      );
      expect(messagesOf(price)).toEqual([OWNER_ONLY_PRICE_MESSAGE]);
      expect(messagesOf(price)[0]).toMatch(/change a price/);

      const added = await addItem(A.manager, newDish).expect(403);
      expect(messagesOf(added)).toEqual([OWNER_ONLY_NEW_MENU_ITEM_MESSAGE]);
      expect(messagesOf(added)[0]).toMatch(only);

      await saveItem(
        A.manager,
        item.id,
        { description: 'Updated', showOnline: false },
        200,
      );
      expect(await menuItem(item.id)).toMatchObject({
        showOnline: false,
        priceKobo: item.priceKobo,
      });

      await saveItem(
        A.owner,
        item.id,
        { priceKobo: item.priceKobo - 100 },
        200,
      );
      expect((await menuItem(item.id)).priceKobo).toBe(item.priceKobo - 100);

      await addItem(A.owner, newDish).expect(201);
      expect(await prisma.menuItem.count({ where: { name: 'New Dish' } })).toBe(
        1,
      );
    });

    it('a manager keeps printer, alerts and the free table reminder but not tax, delivery or the limit', async () => {
      await saveSettings(
        A.manager,
        { printerWidth: PrinterWidth.MM58, freeTableReminderMinutes: 120 },
        200,
      );
      expect(await settings()).toMatchObject({
        printerWidth: PrinterWidth.MM58,
        freeTableReminderMinutes: 120,
      });

      for (const changes of [
        { vatBps: 1000 },
        { serviceBps: 500 },
        { deliveryJosKobo: 1 },
        { deliveryOutsideKobo: 1 },
        { approvalLimitKobo: 99_999_999 },
        { depositKobo: 100 },
      ]) {
        const refused = await saveSettings(A.manager, changes, 403);

        expect(messagesOf(refused)).toEqual([OWNER_ONLY_SETTINGS_MESSAGE]);
        expect(messagesOf(refused)[0]).toMatch(only);
      }

      await saveSettings(
        A.owner,
        { approvalLimitKobo: 2_000_000, vatBps: 750 },
        200,
      );
      expect((await settings()).approvalLimitKobo).toBe(2_000_000);
    });

    it('only the Owner creates or changes Manager and Owner accounts, and one Owner always remains', async () => {
      const refusedSentence = [OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE];

      await hire(
        A.manager,
        StaffRole.CASHIER,
        'new.cashier@example.com',
      ).expect(201);
      expect(
        await prisma.staff.count({
          where: { email: 'new.cashier@example.com' },
        }),
      ).toBe(1);

      for (const role of [StaffRole.MANAGER, StaffRole.OWNER]) {
        const refused = await hire(
          A.manager,
          role,
          `second.${role.toLowerCase()}@example.com`,
        ).expect(403);
        expect(messagesOf(refused)).toEqual(refusedSentence);
      }

      const promote = await saveStaff(
        A.manager,
        A.waiter.id,
        { role: StaffRole.MANAGER },
        403,
      );
      expect(messagesOf(promote)).toEqual(refusedSentence);

      const demote = await saveStaff(
        A.manager,
        A.manager2.id,
        { role: StaffRole.CASHIER, reason: 'Demote' },
        403,
      );
      expect(messagesOf(demote)).toEqual(refusedSentence);

      const lockOut = await saveStaff(
        A.manager,
        A.owner.id,
        { isActive: false, reason: 'Lock out' },
        403,
      );
      expect(messagesOf(lockOut)[0]).toMatch(only);

      await hire(
        A.owner,
        StaffRole.MANAGER,
        'second.manager@example.com',
      ).expect(201);
      expect(
        await prisma.staff.count({
          where: {
            email: 'second.manager@example.com',
            role: StaffRole.MANAGER,
          },
        }),
      ).toBe(1);

      for (const change of [
        { role: StaffRole.MANAGER, reason: 'Demote' },
        { role: StaffRole.OWNER, isActive: false, reason: 'Off' },
      ]) {
        const refused = await saveStaff(A.owner, A.owner.id, change, 403);

        expect(messagesOf(refused)).toEqual([LAST_ACTIVE_OWNER_MESSAGE]);
        expect(messagesOf(refused)[0]).toMatch(/at least one active Owner/);
      }
    });

    it('managers see their own actions and the Owner and staff actions, never another manager’s; the Owner sees all', async () => {
      await saveSettings(A.manager, { printerWidth: PrinterWidth.A4 }, 200);
      await saveSettings(A.manager2, { printerWidth: PrinterWidth.MM80 }, 200);
      await saveSettings(A.owner, { printerWidth: PrinterWidth.MM58 }, 200);
      await uploadPhoto(A.cashier, A.cashier.id, 200);

      const four = [A.manager.id, A.manager2.id, A.owner.id, A.cashier.id];

      async function seen(by: Actor): Promise<string[]> {
        const response = await auditAs(by).expect(200);
        const rows = (response.body as { data: { staffId: string | null }[] })
          .data;

        return four.filter((id) => rows.some((row) => row.staffId === id));
      }

      expect(await seen(A.manager)).toEqual([
        A.manager.id,
        A.owner.id,
        A.cashier.id,
      ]);
      expect(await seen(A.owner)).toEqual(four);

      // The demo returned all four to the Cashier (`visibleAudit`). The
      // server does not (plan §4.8): a non-manager reads only the history
      // of a record they can see, by its ref.
      const cashier = await auditAs(A.cashier).expect(403);
      expect(messagesOf(cashier)).toEqual([ROLE_REFUSED_MESSAGE]);
    });

    it('history is append only: no command edits or removes an audit entry', async () => {
      const read = () =>
        prisma.auditLog.findMany({ orderBy: [{ at: 'asc' }, { id: 'asc' }] });

      const before = await read();

      await saveSettings(A.manager, { printerWidth: PrinterWidth.A4 }, 200);

      const after = await read();

      expect(after.slice(0, before.length)).toEqual(before);
      expect(after).toHaveLength(before.length + 1);

      // The demo checked its source: only the seed assigns the audit list,
      // and nothing splices it. Here: only AuditService writes the table,
      // only by insert, and nothing updates or deletes it. The trigger that
      // enforces it in the database is proven in schema.e2e-spec.ts.
      const writers: string[] = [];

      for (const file of sourceFiles(join(__dirname, '..', 'src'))) {
        const text = readFileSync(file, 'utf8');

        expect(text).not.toMatch(
          /\.auditLog\.(update|updateMany|upsert|delete|deleteMany)\b/,
        );
        expect(text).not.toMatch(/(UPDATE|DELETE FROM|TRUNCATE)\s+"AuditLog"/i);

        if (/\.auditLog\.create(Many)?\b/.test(text)) {
          writers.push(relative(join(__dirname, '..'), file));
        }
      }

      expect(writers).toEqual([join('src', 'audit', 'audit.service.ts')]);
    });

    it('the Daily Approval Limit caps one manager across decisions, is on by default, and only the Owner changes it', async () => {
      // On by default at ₦150,000. The cap across waste and purchase
      // approvals is MoneyControlService.withinLimit, proven against the
      // ledger in money-control.e2e-spec.ts; waste.approve itself is C5.
      expect(await settings()).toMatchObject({
        dailyLimitOn: true,
        dailyLimitKobo: 15_000_000,
      });

      await saveSettings(A.owner, { dailyLimitKobo: 1_500_000 }, 200);

      for (const changes of [
        { dailyLimitOn: false },
        { dailyLimitKobo: 99_999_999 },
      ]) {
        const refused = await saveSettings(A.manager, changes, 403);
        expect(messagesOf(refused)[0]).toMatch(only);
      }

      await saveSettings(A.manager, { printerWidth: PrinterWidth.MM58 }, 200);

      await saveSettings(A.owner, { dailyLimitOn: false }, 200);
      expect((await settings()).dailyLimitOn).toBe(false);
      await saveSettings(A.owner, { dailyLimitOn: true }, 200);
      expect(await settings()).toMatchObject({
        dailyLimitOn: true,
        dailyLimitKobo: 1_500_000,
      });
    });
  });

  // ----------------------------------------------------- revision.test.cjs

  describe('revision.test.cjs', () => {
    it('email changes preserve QR and staff ID, increment session version and cannot reuse another email', async () => {
      const person = await createStaffAccount(prisma, StaffRole.WAITER, {
        emailPrefix: 'revision',
      });
      const before = await prisma.staff.findUniqueOrThrow({
        where: { id: person.id },
      });
      // A session the change must end (the demo's sessionVersion + 1).
      const session = await tokens.issueTokenPair(person.id, SubjectType.STAFF);

      const unreasoned = await saveStaff(
        A.manager,
        person.id,
        { email: 'new@cnc.example' },
        400,
      );
      expect(messagesOf(unreasoned)).toEqual([STAFF_EMAIL_REASON_MESSAGE]);
      expect(messagesOf(unreasoned)[0]).toMatch(/reason/);

      await saveStaff(
        A.manager,
        person.id,
        { email: 'new@cnc.example', reason: 'New email' },
        200,
      );

      const saved = await prisma.staff.findUniqueOrThrow({
        where: { id: person.id },
      });
      expect(saved.qrToken).toBe(before.qrToken);
      expect(saved.staffNo).toBe(before.staffNo);
      expect(saved.email).toBe('new@cnc.example');

      await request(server())
        .post('/api/v1/auth/staff/refresh')
        .set('X-Forwarded-For', clientAddress())
        .set('Cookie', `${STAFF_REFRESH_COOKIE}=${session.refreshToken}`)
        .set('Content-Type', 'application/json')
        .send({})
        .expect(401);

      const duplicate = await saveStaff(
        A.manager,
        person.id,
        { email: A.owner.email, reason: 'Duplicate' },
        409,
      );
      expect(messagesOf(duplicate)).toEqual([STAFF_EMAIL_TAKEN_MESSAGE]);
      expect(messagesOf(duplicate)[0]).toMatch(/another account/);
    });

    it('staff can change only their own photo and photographs do not bloat audit snapshots', async () => {
      await uploadPhoto(A.waiter, A.waiter.id, 200);

      const refused = await uploadPhoto(A.waiter, A.manager.id, 403);
      expect(messagesOf(refused)).toEqual([OWN_PHOTO_ONLY_MESSAGE]);
      expect(messagesOf(refused)[0]).toMatch(/own photograph/);

      await saveStaff(
        A.manager,
        A.waiter.id,
        { name: 'Test Waiter Reviewed', reason: 'Review' },
        200,
      );

      const row = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'staff.save', ref: A.waiter.staffNo },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
      });
      const after = row.after as Record<string, unknown>;

      expect(after.hasPhoto).toBe(true);
      expect(after.photo).toBeUndefined();
      expect(JSON.stringify(row.after)).not.toMatch(/gs:\/\/|base64/);
    });

    it('existing demo records migrate once without replacing staff identities or attendance', async () => {
      // Nothing migrates on the server: there is no browser copy of the
      // records. What carries over is the page rule the test ends on:
      // Reception cannot open Online Orders, and everyone has My Staff ID.
      async function pagesOf(actor: Actor): Promise<string[]> {
        const response = await request(server())
          .get('/api/v1/staff/me')
          .set(as(actor))
          .expect(200);

        return (response.body as { pages: string[] }).pages;
      }

      expect(await pagesOf(A.reception)).not.toContain('online');

      for (const actor of Object.values(A)) {
        expect(await pagesOf(actor)).toContain('myid');
      }
    });
  });

  // ----------------------------------------------------------- ux.test.cjs

  describe('ux.test.cjs', () => {
    it('required choices and whitespace report actionable field errors while optional choices remain optional', async () => {
      const blankName = await createPerson(A.manager, {
        name: '   ',
        role: StaffRole.CASHIER,
        email: 'blank.name@example.com',
      }).expect(400);
      expect(messagesOf(blankName)).toContain(STAFF_NAME_AND_ROLE_MESSAGE);

      const unknownRole = await createPerson(A.manager, {
        name: 'Choice',
        role: 'unknown',
        email: 'choice@example.com',
      }).expect(400);
      expect(messagesOf(unknownRole)).toContain(STAFF_NAME_AND_ROLE_MESSAGE);

      // isActive is optional and may be left out.
      await createPerson(A.manager, {
        name: 'Optional',
        role: StaffRole.WAITER,
        email: 'optional@example.com',
      }).expect(201);

      const blankReason = await saveStaff(
        A.manager,
        A.store.id,
        { email: 'store.moved@example.com', reason: '   ' },
        400,
      );
      expect(messagesOf(blankReason)).toEqual([STAFF_EMAIL_REASON_MESSAGE]);
    });

    it('numeric fields accept required zero and valid fractional steps while rejecting out of range, nonfinite and fractional portion counts', async () => {
      await saveSettings(A.owner, { serviceBps: 500 }, 200);
      await saveSettings(A.owner, { serviceBps: 0 }, 200);
      expect((await settings()).serviceBps).toBe(0);

      for (const [value, sentence] of [
        [-1, SETTINGS_NUMBERS_MESSAGE],
        [2.5, SETTINGS_NUMBERS_MESSAGE],
        ['Infinity', SETTINGS_NUMBERS_MESSAGE],
        [10_001, SETTINGS_RANGES_MESSAGE],
      ] as const) {
        const refused = await saveSettings(A.owner, { serviceBps: value }, 400);

        expect(messagesOf(refused)).toContain(sentence);
      }

      // Money is whole kobo: a price of 1.5 kobo, or of nothing, is refused.
      const [item] = await restaurantMenu(A.owner);

      for (const priceKobo of [1.5, 0]) {
        const refused = await saveItem(A.owner, item.id, { priceKobo }, 400);

        expect(messagesOf(refused)).toContain(MENU_NAME_PRICE_MESSAGE);
      }
    });

    it('a failed command keeps persisted records untouched and cannot approve under an unauthorised role', async () => {
      // purchase.approve arrives in C5; settings.save is the managers-only
      // command that exists, refused to a Waiter by the same rule.
      const read = () =>
        Promise.all([
          prisma.settings.findFirstOrThrow(),
          prisma.auditLog.count(),
        ]);

      const before = await read();

      const refused = await saveSettings(
        A.waiter,
        { printerWidth: PrinterWidth.MM80 },
        403,
      );
      expect(messagesOf(refused)[0]).toMatch(
        /current staff role cannot perform/i,
      );

      expect(await read()).toEqual(before);
    });
  });
});

/** Every non-spec TypeScript file under `root`. */
function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}
