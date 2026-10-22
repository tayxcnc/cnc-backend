import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AssetStatus,
  MaintenanceStatus,
  StaffRole,
  TaskStatus,
  TaskType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import {
  ASSET_FIELDS_MESSAGE,
  ASSET_NOT_FOUND_MESSAGE,
  ASSET_STATUS_MESSAGE,
  ASSET_TAG_TAKEN_MESSAGE,
  REPAIR_ASSET_VENDOR_MESSAGE,
  REPAIR_DESCRIPTION_COST_MESSAGE,
  REPAIR_NOT_FOUND_MESSAGE,
  REPAIR_STATUS_MESSAGE,
  REPAIR_TASK_TYPE_MESSAGE,
  TASK_HAS_REPAIR_MESSAGE,
} from '../src/assets/asset-messages';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { drawNumber } from '../src/prisma/sequences';
import { TASK_NOT_FOUND_MESSAGE } from '../src/tasks/task-messages';
import { createTestApp } from './create-test-app';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * Assets and repairs (card C5-6) through HTTP and against Postgres:
 * `asset.save`, `maintenance.save` with its follow-up task, the asset
 * moving with its repair, R3's resolved date, the reads, the reference's
 * lite list and the MT- history reader. The demo's repair case
 * (`stock.test.cjs`, "a new repair raises a task for the manager that
 * closes when fixed") is ported by name.
 *
 * It runs on a database of its own, because the follow-up task goes to
 * CNC's *first* active Manager, which must be this suite's.
 */
describe('Assets and maintenance (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  const originalUrl = process.env.CNC_DB_URL;

  /** Made in this order: `manager` is the first Manager. */
  type Actor =
    'owner' | 'manager' | 'reception' | 'kitchen' | 'waiter' | 'storekeeper';

  const ROLE: Record<Actor, StaffRole> = {
    owner: StaffRole.OWNER,
    manager: StaffRole.MANAGER,
    reception: StaffRole.RECEPTION,
    kitchen: StaffRole.KITCHEN,
    waiter: StaffRole.WAITER,
    storekeeper: StaffRole.STOREKEEPER,
  };

  const staffId: Partial<Record<Actor, string>> = {};
  const token: Partial<Record<Actor, string>> = {};

  interface Asset {
    id: string;
    tag: string;
    name: string;
    category: string;
    location: string;
    quantity: number;
    status: AssetStatus;
    version: number;
  }

  interface Repair {
    id: string;
    number: string;
    assetId: string;
    assetTag: string;
    vendorName: string;
    description: string;
    costKobo: number;
    reportedOn: string;
    resolvedOn: string | null;
    status: MaintenanceStatus;
    history: { status: MaintenanceStatus; staffId: string }[];
    tasks: { id: string; number: string; status: TaskStatus }[];
    version: number;
  }

  let vendorId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    const tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);

    for (const actor of Object.keys(ROLE) as Actor[]) {
      const account = await createStaffAccount(prisma, ROLE[actor], {
        emailPrefix: 'assets',
        name: `Assets ${actor}`,
      });
      staffId[actor] = account.id;
      token[actor] = await accessTokenFor(tokens, account.id);
    }

    vendorId = (
      (
        await request(server())
          .post('/api/v1/staff/vendors')
          .set(as('storekeeper'))
          .set('Idempotency-Key', randomUUID())
          .send({
            name: 'Jos Cooling Services',
            service: 'Air conditioning',
            phone: '08000000040',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const as = (actor: Actor) => ({ Authorization: `Bearer ${token[actor]}` });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;
  const today = () => formatIsoDate(watToday(new Date()));

  const saveAsset = (
    actor: Actor,
    tag: string,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .put(`/api/v1/staff/assets/${encodeURIComponent(tag)}`)
      .set(as(actor))
      .send(body);

  const logRepair = (
    actor: Actor,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) =>
    request(server())
      .post('/api/v1/staff/maintenance')
      .set(as(actor))
      .set('Idempotency-Key', key)
      .send(body);

  const updateRepair = (
    actor: Actor,
    id: string,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .patch(`/api/v1/staff/maintenance/${id}`)
      .set(as(actor))
      .send(body);

  async function newAsset(tag: string, name: string): Promise<Asset> {
    return (
      await saveAsset('manager', tag, {
        name,
        category: 'IT',
        location: 'Reception',
        quantity: 1,
      }).expect(201)
    ).body as Asset;
  }

  const assetRow = (id: string) =>
    prisma.asset.findUniqueOrThrow({ where: { id } });

  describe('asset.save', () => {
    it('adds an asset under its tag, Active by default, and refuses the tag again', async () => {
      const response = await saveAsset('manager', 'AC1', {
        name: 'Lounge air conditioner',
        category: 'Cooling',
        location: 'Lounge',
        quantity: 1,
      }).expect(201);

      const created = response.body as Asset;

      expect(typeof created.id).toBe('string');
      expect(created).toEqual({
        id: created.id,
        tag: 'AC1',
        name: 'Lounge air conditioner',
        category: 'Cooling',
        location: 'Lounge',
        quantity: 1,
        status: AssetStatus.ACTIVE,
        version: 0,
      });

      const again = await saveAsset('manager', 'AC1', {
        name: 'Another',
        quantity: 1,
      }).expect(409);
      expect(messageOf(again)).toBe(ASSET_TAG_TAKEN_MESSAGE);

      const audit = await prisma.auditLog.findMany({
        where: { action: 'asset.save', ref: 'AC1' },
      });
      expect(audit).toHaveLength(1);
    });

    it('changes the asset the tag names at its version, keeping its status unless one is sent', async () => {
      const chairs = (
        await saveAsset('manager', 'CHR1', {
          name: 'Diner chairs',
          quantity: 28,
          status: AssetStatus.UNDER_REPAIR,
        }).expect(201)
      ).body as Asset;

      const changed = (
        await saveAsset('owner', 'CHR1', {
          name: 'Diner chairs',
          location: 'Diner',
          quantity: 30,
          version: chairs.version,
        }).expect(200)
      ).body as Asset;

      expect(changed).toMatchObject({
        quantity: 30,
        location: 'Diner',
        status: AssetStatus.UNDER_REPAIR,
        version: chairs.version + 1,
      });

      const stale = await saveAsset('manager', 'CHR1', {
        name: 'Diner chairs',
        quantity: 31,
        version: chairs.version,
      }).expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);

      const inactive = (
        await saveAsset('manager', 'CHR1', {
          name: 'Diner chairs',
          quantity: 30,
          status: AssetStatus.INACTIVE,
          version: changed.version,
        }).expect(200)
      ).body as Asset;
      expect(inactive.status).toBe(AssetStatus.INACTIVE);
    });

    it('answers the demo’s sentence for a missing tag, name or quantity, and the new ones', async () => {
      for (const body of [
        { name: '', quantity: 1 },
        { name: 'Chairs', quantity: 0 },
        { name: 'Chairs', quantity: 1.5 },
        { name: 'Chairs' },
      ]) {
        const response = await saveAsset('manager', 'BAD1', body).expect(400);
        expect(messageOf(response)).toEqual(ASSET_FIELDS_MESSAGE);
      }

      const blankTag = await saveAsset('manager', ' ', {
        name: 'Chairs',
        quantity: 1,
      }).expect(400);
      expect(messageOf(blankTag)).toBe(ASSET_FIELDS_MESSAGE);

      const status = await saveAsset('manager', 'BAD1', {
        name: 'Chairs',
        quantity: 1,
        status: 'Broken',
      }).expect(400);
      expect(messageOf(status)).toEqual([ASSET_STATUS_MESSAGE]);

      const unknown = await saveAsset('manager', 'NOPE1', {
        name: 'Chairs',
        quantity: 1,
        version: 0,
      }).expect(404);
      expect(messageOf(unknown)).toBe(ASSET_NOT_FOUND_MESSAGE);
    });

    it('is for managers only', async () => {
      for (const actor of ['reception', 'storekeeper'] as const) {
        const response = await saveAsset(actor, 'X1', {
          name: 'Chairs',
          quantity: 1,
        }).expect(403);
        expect(messageOf(response)).toBe(ROLE_REFUSED_MESSAGE);
      }
    });
  });

  describe('the asset reads', () => {
    it('lets Reception and managers read the assets, and refuses everyone else', async () => {
      const page = (
        await request(server())
          .get('/api/v1/staff/assets?q=lounge')
          .set(as('reception'))
          .expect(200)
      ).body as { data: Asset[]; total: number };

      expect(page.data.map((asset) => asset.tag)).toContain('AC1');

      for (const actor of ['kitchen', 'waiter'] as const) {
        await request(server())
          .get('/api/v1/staff/assets')
          .set(as(actor))
          .expect(403);
      }
    });

    it('carries the lite list on the reference for Reception and managers only', async () => {
      const reference = async (actor: Actor) =>
        (
          (
            await request(server())
              .get('/api/v1/staff/reference')
              .set(as(actor))
              .expect(200)
          ).body as { assets: Record<string, unknown>[] }
        ).assets;

      const forReception = await reference('reception');
      const ac1 = forReception.find((asset) => asset.tag === 'AC1');

      const stored = await prisma.asset.findUniqueOrThrow({
        where: { tag: 'AC1' },
      });

      expect(ac1).toEqual({
        id: stored.id,
        tag: 'AC1',
        name: 'Lounge air conditioner',
        location: 'Lounge',
        status: AssetStatus.ACTIVE,
      });
      expect((await reference('manager')).length).toBe(forReception.length);
      expect(await reference('kitchen')).toEqual([]);
    });
  });

  describe('maintenance.save', () => {
    it('a new repair raises a task for the manager that closes when fixed (stock.test.cjs)', async () => {
      const till = await newAsset('POS1', 'Cashier terminal');

      const logged = (
        await logRepair('reception', {
          assetId: till.id,
          vendorId,
          description: 'Screen flickers',
          costKobo: 0,
          status: MaintenanceStatus.PENDING,
        }).expect(201)
      ).body as Repair;

      expect(logged.number).toMatch(/^MT-\d{6}$/);
      expect(logged).toMatchObject({
        assetTag: 'POS1',
        vendorName: 'Jos Cooling Services',
        status: MaintenanceStatus.PENDING,
        reportedOn: today(),
        resolvedOn: null,
        history: [
          { status: MaintenanceStatus.PENDING, staffId: staffId.reception },
        ],
      });
      expect(logged.tasks).toHaveLength(1);

      const task = await prisma.task.findUniqueOrThrow({
        where: { id: logged.tasks[0].id },
      });
      expect(task).toMatchObject({
        title: `Follow up repair ${logged.number}: Cashier terminal`,
        type: TaskType.MAINTENANCE,
        status: TaskStatus.OPEN,
        assignedToId: staffId.manager,
        raisedById: staffId.reception,
        automatic: true,
        maintenanceId: logged.id,
      });
      expect((await assetRow(till.id)).status).toBe(AssetStatus.UNDER_REPAIR);

      const fixed = (
        await updateRepair('reception', logged.id, {
          assetId: till.id,
          vendorId,
          description: 'Screen flickers',
          costKobo: 1_500_000,
          status: MaintenanceStatus.FIXED,
          reason: 'Replaced cable',
          version: logged.version,
        }).expect(200)
      ).body as Repair;

      expect(fixed).toMatchObject({
        status: MaintenanceStatus.FIXED,
        costKobo: 1_500_000,
        resolvedOn: today(),
        tasks: [{ id: task.id, status: TaskStatus.DONE }],
      });
      expect(fixed.history.map((step) => step.status)).toEqual([
        MaintenanceStatus.PENDING,
        MaintenanceStatus.FIXED,
      ]);

      const closed = await prisma.task.findUniqueOrThrow({
        where: { id: task.id },
      });
      expect(closed.version).toBe(task.version + 1);
      expect((await assetRow(till.id)).status).toBe(AssetStatus.ACTIVE);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'maintenance.save', ref: logged.number },
        orderBy: { at: 'desc' },
      });
      expect(audit.reason).toBe('Replaced cable');
    });

    it('sets the resolved date once and keeps it, a reopened repair included (R3)', async () => {
      const fridge = await newAsset('FR1', 'Kitchen fridge');
      const logged = (
        await logRepair('reception', {
          assetId: fridge.id,
          vendorId,
          description: 'Not cooling',
          costKobo: 0,
          status: MaintenanceStatus.FIXED,
        }).expect(201)
      ).body as Repair;

      expect(logged.resolvedOn).toBe(today());

      // As if it was reported and fixed a week ago.
      const weekAgo = new Date(watToday(new Date()).getTime() - 7 * 86_400_000);
      await prisma.maintenanceRecord.update({
        where: { id: logged.id },
        data: { reportedOn: weekAgo, resolvedOn: weekAgo },
      });

      const recosted = (
        await updateRepair('reception', logged.id, {
          assetId: fridge.id,
          vendorId,
          description: 'Not cooling',
          costKobo: 900_000,
          status: MaintenanceStatus.FIXED,
          version: logged.version,
        }).expect(200)
      ).body as Repair;
      expect(recosted.resolvedOn).toBe(formatIsoDate(weekAgo));
      expect(recosted.reportedOn).toBe(formatIsoDate(weekAgo));

      const reopened = (
        await updateRepair('reception', logged.id, {
          assetId: fridge.id,
          vendorId,
          description: 'Not cooling again',
          costKobo: 900_000,
          status: MaintenanceStatus.IN_PROGRESS,
          version: recosted.version,
        }).expect(200)
      ).body as Repair;
      expect(reopened.resolvedOn).toBe(formatIsoDate(weekAgo));
      expect((await assetRow(fridge.id)).status).toBe(AssetStatus.UNDER_REPAIR);
    });

    it('marks an asset that could not be fixed Inactive', async () => {
      const fan = await newAsset('FAN1', 'Ceiling fan');
      const logged = (
        await logRepair('manager', {
          assetId: fan.id,
          vendorId,
          description: 'Motor burnt',
          costKobo: 0,
          status: MaintenanceStatus.IN_PROGRESS,
        }).expect(201)
      ).body as Repair;

      const notFixed = (
        await updateRepair('reception', logged.id, {
          assetId: fan.id,
          vendorId,
          description: 'Motor burnt',
          costKobo: 0,
          status: MaintenanceStatus.NOT_FIXED,
          version: logged.version,
        }).expect(200)
      ).body as Repair;

      expect(notFixed.tasks.map((task) => task.status)).toEqual([
        TaskStatus.DONE,
      ]);
      expect((await assetRow(fan.id)).status).toBe(AssetStatus.INACTIVE);
    });

    it('links the task a repair is logged for, instead of raising a follow-up', async () => {
      const printer = await newAsset('PRN1', 'Docket printer');
      const raised = await request(server())
        .post('/api/v1/staff/tasks')
        .set(as('manager'))
        .set('Idempotency-Key', randomUUID())
        .send({
          title: 'Printer jams',
          type: TaskType.GENERAL,
          status: TaskStatus.OPEN,
          assignedToId: staffId.reception,
        })
        .expect(201);
      const taskId = (raised.body as { id: string; version: number }).id;
      const version = (raised.body as { version: number }).version;

      const logged = (
        await logRepair('reception', {
          assetId: printer.id,
          vendorId,
          description: 'Printer jams',
          costKobo: 0,
          status: MaintenanceStatus.PENDING,
          taskId,
        }).expect(201)
      ).body as Repair;

      expect(logged.tasks.map((task) => task.id)).toEqual([taskId]);
      expect(
        await prisma.task.findUniqueOrThrow({ where: { id: taskId } }),
      ).toMatchObject({
        type: TaskType.MAINTENANCE,
        status: TaskStatus.IN_PROGRESS,
        maintenanceId: logged.id,
        version: version + 1,
      });
      expect(
        await prisma.task.count({ where: { maintenanceId: logged.id } }),
      ).toBe(1);

      // The repair's own task sent back with an update links nothing new.
      await updateRepair('reception', logged.id, {
        assetId: printer.id,
        vendorId,
        description: 'Printer jams',
        costKobo: 0,
        status: MaintenanceStatus.IN_PROGRESS,
        taskId,
        version: logged.version,
      }).expect(200);

      // Another repair cannot take a task that already has one.
      const taken = await logRepair('reception', {
        assetId: printer.id,
        vendorId,
        description: 'Second fault',
        costKobo: 0,
        status: MaintenanceStatus.PENDING,
        taskId,
      }).expect(409);
      expect(messageOf(taken)).toBe(TASK_HAS_REPAIR_MESSAGE);
    });

    it('refuses in the demo’s order, and answers an unknown task with 404 (R3)', async () => {
      const asset = await newAsset('ORD1', 'Order screen');
      const good = {
        assetId: asset.id,
        vendorId,
        description: 'Cracked',
        costKobo: 0,
        status: MaintenanceStatus.PENDING,
      };
      const refused = async (
        body: Record<string, unknown>,
        status: number,
        message: string,
      ) => {
        const response = await logRepair('reception', body).expect(status);
        expect(messageOf(response)).toBe(message);
      };

      await refused(
        { ...good, vendorId: 'nope', description: '' },
        400,
        REPAIR_ASSET_VENDOR_MESSAGE,
      );
      await refused(
        { ...good, assetId: undefined },
        400,
        REPAIR_ASSET_VENDOR_MESSAGE,
      );
      await refused(
        { ...good, description: ' ', status: 'Broken' },
        400,
        REPAIR_DESCRIPTION_COST_MESSAGE,
      );
      await refused(
        { ...good, costKobo: -1 },
        400,
        REPAIR_DESCRIPTION_COST_MESSAGE,
      );
      await refused({ ...good, status: 'Fixed' }, 400, REPAIR_STATUS_MESSAGE);
      await refused(
        { ...good, taskId: 'no-such-task' },
        404,
        TASK_NOT_FOUND_MESSAGE,
      );

      // A Purchase task tracks a requisition; the row is made directly.
      const purchaseTask = await prisma.task.create({
        data: {
          number: await drawNumber(prisma, 'task'),
          title: 'Chase the order',
          type: TaskType.PURCHASE,
          assignedToId: staffId.manager!,
          raisedById: staffId.manager!,
        },
        select: { id: true },
      });

      await refused(
        { ...good, taskId: purchaseTask.id },
        400,
        REPAIR_TASK_TYPE_MESSAGE,
      );

      // Nothing was logged by any refusal.
      expect(
        await prisma.maintenanceRecord.count({ where: { assetId: asset.id } }),
      ).toBe(0);
    });

    it('replays a retried create instead of logging the repair twice', async () => {
      const asset = await newAsset('IDEM1', 'Blender');
      const key = randomUUID();
      const body = {
        assetId: asset.id,
        vendorId,
        description: 'Blade loose',
        costKobo: 0,
        status: MaintenanceStatus.PENDING,
      };

      const first = (await logRepair('reception', body, key).expect(201))
        .body as Repair;
      const second = (await logRepair('reception', body, key).expect(201))
        .body as Repair;

      expect(second.id).toBe(first.id);
      expect(
        await prisma.maintenanceRecord.count({ where: { assetId: asset.id } }),
      ).toBe(1);
      expect(
        await prisma.task.count({ where: { maintenanceId: first.id } }),
      ).toBe(1);
    });

    it('refuses a stale save and an unknown repair', async () => {
      const asset = await newAsset('STALE1', 'Grill');
      const logged = (
        await logRepair('reception', {
          assetId: asset.id,
          vendorId,
          description: 'Igniter',
          costKobo: 0,
          status: MaintenanceStatus.PENDING,
        }).expect(201)
      ).body as Repair;
      const body = {
        assetId: asset.id,
        vendorId,
        description: 'Igniter',
        costKobo: 0,
        status: MaintenanceStatus.IN_PROGRESS,
      };

      await updateRepair('reception', logged.id, {
        ...body,
        version: logged.version,
      }).expect(200);

      const stale = await updateRepair('manager', logged.id, {
        ...body,
        version: logged.version,
      }).expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);

      const unknown = await updateRepair('reception', 'no-such-repair', {
        ...body,
        version: 0,
      }).expect(404);
      expect(messageOf(unknown)).toBe(REPAIR_NOT_FOUND_MESSAGE);
    });

    it('is Reception’s and managers’ only', async () => {
      for (const actor of ['kitchen', 'waiter', 'storekeeper'] as const) {
        const response = await logRepair(actor, {
          assetId: 'x',
          vendorId,
          description: 'x',
          costKobo: 0,
          status: MaintenanceStatus.PENDING,
        }).expect(403);
        expect(messageOf(response)).toBe(ROLE_REFUSED_MESSAGE);
      }
    });
  });

  describe('the repairs read and history', () => {
    it('lists repairs newest first with filters, for Reception and managers only', async () => {
      const page = (
        await request(server())
          .get('/api/v1/staff/maintenance')
          .query({ status: MaintenanceStatus.FIXED, q: 'POS1' })
          .set(as('reception'))
          .expect(200)
      ).body as { data: Repair[]; total: number };

      expect(page.total).toBe(1);
      expect(page.data[0]).toMatchObject({
        assetTag: 'POS1',
        status: MaintenanceStatus.FIXED,
      });

      const bad = await request(server())
        .get('/api/v1/staff/maintenance?status=Fixed')
        .set(as('manager'))
        .expect(400);
      expect(messageOf(bad)).toEqual(['Choose a repair status.']);

      await request(server())
        .get('/api/v1/staff/maintenance')
        .set(as('kitchen'))
        .expect(403);
    });

    it('lets Reception read a repair’s history by its number, and no other role but managers', async () => {
      const repair = await prisma.maintenanceRecord.findFirstOrThrow({
        select: { number: true },
      });
      const read = (actor: Actor) =>
        request(server())
          .get('/api/v1/staff/audit')
          .query({ ref: repair.number })
          .set(as(actor));

      const rows = (await read('reception').expect(200)).body as {
        data: { action: string }[];
      };
      expect(rows.data.length).toBeGreaterThan(0);
      expect(rows.data.every((row) => row.action === 'maintenance.save')).toBe(
        true,
      );

      await read('kitchen').expect(403);
      await read('manager').expect(200);

      await request(server())
        .get('/api/v1/staff/audit')
        .query({ ref: 'MT-999999' })
        .set(as('reception'))
        .expect(403);
    });
  });
});
