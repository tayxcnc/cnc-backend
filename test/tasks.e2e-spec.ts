import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  MaintenanceStatus,
  StaffRole,
  TaskStatus,
  TaskType,
} from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { watToday } from '../src/common/wat';
import { IDEMPOTENCY_KEY_REQUIRED } from '../src/idempotency/idempotency-key.decorator';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { drawNumber } from '../src/prisma/sequences';
import {
  ASSIGNED_ONLY_MESSAGE,
  ASSIGNEE_MESSAGE,
  MANAGER_DETAILS_MESSAGE,
  MANAGER_LINKS_MESSAGE,
  MANAGER_REASSIGN_MESSAGE,
  OPEN_MAINTENANCE_MESSAGE,
  OPEN_PURCHASE_MESSAGE,
  RAISE_TO_MESSAGE,
  TASK_NOT_FOUND_MESSAGE,
  TASK_STATUS_FILTER_MESSAGE,
  TASK_STATUS_MESSAGE,
  TASK_TITLE_MESSAGE,
  TASK_TYPE_MESSAGE,
} from '../src/tasks/task-messages';
import { createTestApp } from './create-test-app';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { readBell } from './staff-bell';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * Tasks (card C5-5) through HTTP and against Postgres: `task.save` raising,
 * assigning, moving and linking a task, the tasks read and who sees which,
 * the automatic tasks C5-3 raises seen and saved like any other, the task
 * history and the assigned-task bell item. The demo's task cases
 * (`stock.test.cjs`, `domain.test.cjs`, `revision.test.cjs`,
 * `attendance.test.cjs`) are ported by name.
 *
 * It runs on a database of its own (`createIsolatedDatabase`), seeded with
 * the real reference data (`seedData`), because a purchase's automatic
 * tasks go to CNC's *first* active Manager and Storekeeper, which must be
 * this suite's for "who sees which" to be asserted.
 */
describe('Tasks (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  const originalUrl = process.env.CNC_DB_URL;

  /** Made in this order: `manager` is the first Manager, `storekeeper` the only Storekeeper. */
  type Actor =
    | 'owner'
    | 'manager'
    | 'manager2'
    | 'reception'
    | 'cashier'
    | 'kitchen'
    | 'storekeeper'
    | 'waiter'
    | 'bartender'
    | 'retired';

  const ROLE: Record<Actor, StaffRole> = {
    owner: StaffRole.OWNER,
    manager: StaffRole.MANAGER,
    manager2: StaffRole.MANAGER,
    reception: StaffRole.RECEPTION,
    cashier: StaffRole.CASHIER,
    kitchen: StaffRole.KITCHEN,
    storekeeper: StaffRole.STOREKEEPER,
    waiter: StaffRole.WAITER,
    bartender: StaffRole.BARTENDER,
    retired: StaffRole.KITCHEN,
  };

  const staffId: Partial<Record<Actor, string>> = {};
  const token: Partial<Record<Actor, string>> = {};

  interface Task {
    id: string;
    number: string;
    title: string;
    type: TaskType;
    status: TaskStatus;
    assignedToId: string;
    assignedToName: string;
    raisedById: string;
    raisedByName: string;
    automatic: boolean;
    purchaseId: string | null;
    purchaseNumber: string | null;
    maintenanceId: string | null;
    maintenanceNumber: string | null;
    history: {
      status: TaskStatus;
      staffId: string | null;
      staffName: string | null;
      automatic: boolean;
    }[];
    version: number;
  }

  interface TaskPage {
    data: Task[];
    total: number;
    counts: { open: number; inProgress: number; done: number };
  }

  let vendorId: string;
  let riceId: string;
  let assetId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    const tokens = app.get(CncTokenService, { strict: false });

    await seedData(prisma);

    for (const actor of Object.keys(ROLE) as Actor[]) {
      const account = await createStaffAccount(prisma, ROLE[actor], {
        emailPrefix: 'tasks',
        name: `Tasks ${actor}`,
        isActive: actor !== 'retired',
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
            name: 'Tasks Repairs',
            service: 'Repairs',
            phone: '08000000030',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    riceId = (
      (
        await request(server())
          .post('/api/v1/staff/stock/items')
          .set(as('manager'))
          .send({
            name: 'Tasks Rice',
            unit: 'portion',
            pack: 'bag',
            factor: 50,
            minimum: 15,
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    // Assets and repairs are C5-6's commands; the rows are made directly.
    assetId = (
      await prisma.asset.create({
        data: { tag: 'POS1', name: 'Front till', quantity: 1 },
        select: { id: true },
      })
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

  const create = (
    actor: Actor,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) =>
    request(server())
      .post('/api/v1/staff/tasks')
      .set(as(actor))
      .set('Idempotency-Key', key)
      .send(body);

  /** A task raised through the route, expected to succeed. */
  async function raise(
    actor: Actor,
    body: Record<string, unknown>,
  ): Promise<Task> {
    return (
      await create(actor, {
        type: 'GENERAL',
        status: 'OPEN',
        ...body,
      }).expect(201)
    ).body as Task;
  }

  const save = (
    actor: Actor,
    task: Task,
    changes: Record<string, unknown> = {},
  ) =>
    request(server())
      .patch(`/api/v1/staff/tasks/${task.id}`)
      .set(as(actor))
      .send({
        version: task.version,
        title: task.title,
        type: task.type,
        status: task.status,
        assignedToId: task.assignedToId,
        ...(task.purchaseId === null ? {} : { purchaseId: task.purchaseId }),
        ...(task.maintenanceId === null
          ? {}
          : { maintenanceId: task.maintenanceId }),
        ...changes,
      });

  async function read(
    actor: Actor,
    query: Record<string, unknown> = {},
  ): Promise<TaskPage> {
    return (
      await request(server())
        .get('/api/v1/staff/tasks')
        .query({ pageSize: 100, ...query })
        .set(as(actor))
        .expect(200)
    ).body as TaskPage;
  }

  /** A repair, made directly: `maintenance.save` is card C5-6's. */
  async function repair(status: MaintenanceStatus): Promise<string> {
    const today = watToday(new Date());
    const closed =
      status === MaintenanceStatus.FIXED ||
      status === MaintenanceStatus.NOT_FIXED;
    const row = await prisma.maintenanceRecord.create({
      data: {
        number: await drawNumber(prisma, 'maintenance'),
        assetId,
        vendorId,
        description: 'Screen flickers',
        reportedOn: today,
        resolvedOn: closed ? today : null,
        status,
      },
      select: { id: true },
    });

    return row.id;
  }

  /** A requisition raised through the route by the Storekeeper. */
  async function purchase(): Promise<{
    id: string;
    number: string;
    version: number;
  }> {
    return (
      await request(server())
        .post('/api/v1/staff/purchases')
        .set(as('storekeeper'))
        .set('Idempotency-Key', randomUUID())
        .send({
          vendorId,
          lines: [{ stockItemId: riceId, qty: 1, costKobo: 100_000 }],
        })
        .expect(201)
    ).body as { id: string; number: string; version: number };
  }

  describe('raising and assigning', () => {
    it('staff can raise a task to a manager or themselves, not to other staff', async () => {
      const toManager = await raise('storekeeper', {
        title: 'Placed an order with the vendor',
        assignedToId: staffId.manager,
      });
      expect(toManager).toMatchObject({
        title: 'Placed an order with the vendor',
        type: TaskType.GENERAL,
        status: TaskStatus.OPEN,
        assignedToId: staffId.manager,
        assignedToName: 'Tasks manager',
        raisedById: staffId.storekeeper,
        raisedByName: 'Tasks storekeeper',
        automatic: false,
        purchaseId: null,
        maintenanceId: null,
        version: 0,
      });
      expect(toManager.number).toMatch(/^T-\d{6}$/);
      expect(toManager.history).toEqual([
        expect.objectContaining({
          status: TaskStatus.OPEN,
          staffId: staffId.storekeeper,
          automatic: false,
        }),
      ]);

      await raise('storekeeper', {
        title: 'Count the cold room',
        assignedToId: staffId.storekeeper,
      });
      await raise('kitchen', {
        title: 'Hood needs cleaning',
        assignedToId: staffId.owner,
      });

      const toOther = await create('storekeeper', {
        title: 'Do this',
        type: 'GENERAL',
        status: 'OPEN',
        assignedToId: staffId.cashier,
      }).expect(403);
      expect(messageOf(toOther)).toBe(RAISE_TO_MESSAGE);

      const toNobody = await create('reception', {
        title: 'Do this',
        type: 'GENERAL',
        status: 'OPEN',
      }).expect(403);
      expect(messageOf(toNobody)).toBe(RAISE_TO_MESSAGE);
    });

    it('waiters and bartenders have no tasks; cashiers can raise tasks', async () => {
      for (const actor of ['waiter', 'bartender'] as Actor[]) {
        const refused = await create(actor, {
          title: 'Float needed',
          type: 'GENERAL',
          status: 'OPEN',
          assignedToId: staffId.manager,
        }).expect(403);
        expect(messageOf(refused)).toBe(ROLE_REFUSED_MESSAGE);

        await request(server())
          .get('/api/v1/staff/tasks')
          .set(as(actor))
          .expect(403);
      }

      await raise('cashier', {
        title: 'Float needed',
        assignedToId: staffId.manager,
      });

      for (const assignee of ['waiter', 'bartender', 'retired'] as Actor[]) {
        const refused = await create('manager', {
          title: 'Do this',
          type: 'GENERAL',
          status: 'OPEN',
          assignedToId: staffId[assignee],
        }).expect(400);
        expect(messageOf(refused)).toBe(ASSIGNEE_MESSAGE);
      }

      const nobody = await create('manager', {
        title: 'Do this',
        type: 'GENERAL',
        status: 'OPEN',
        assignedToId: 'missing',
      }).expect(400);
      expect(messageOf(nobody)).toBe(ASSIGNEE_MESSAGE);
    });

    it('refuses a blank description, an unknown type or status with the demo’s sentences', async () => {
      const base = {
        title: 'Check the freezer',
        type: 'GENERAL',
        status: 'OPEN',
        assignedToId: staffId.kitchen,
      };
      const cases: [Record<string, unknown>, string][] = [
        [{ ...base, title: '   ' }, TASK_TITLE_MESSAGE],
        [{ ...base, type: 'Chore' }, TASK_TYPE_MESSAGE],
        [{ ...base, status: 'Later' }, TASK_STATUS_MESSAGE],
      ];

      for (const [body, message] of cases) {
        const response = await create('manager', body).expect(400);
        // The ValidationPipe's list: one sentence, once.
        expect(messageOf(response)).toEqual([message]);
      }
    });

    it('takes an Idempotency-Key and replays a retry instead of raising twice', async () => {
      const body = {
        title: 'Replace the bulb',
        type: 'GENERAL',
        status: 'OPEN',
        assignedToId: staffId.reception,
      };

      const missing = await request(server())
        .post('/api/v1/staff/tasks')
        .set(as('manager'))
        .send(body)
        .expect(400);
      expect(messageOf(missing)).toBe(IDEMPOTENCY_KEY_REQUIRED);

      const key = randomUUID();
      const first = (await create('manager', body, key).expect(201))
        .body as Task;
      const again = (await create('manager', body, key).expect(201))
        .body as Task;

      expect(again.number).toBe(first.number);
      expect(await prisma.task.count({ where: { title: body.title } })).toBe(1);
    });
  });

  describe('links', () => {
    it('purchase tasks must link an open requisition', async () => {
      const missing = await create('manager', {
        title: 'Buy stock',
        type: 'PURCHASE',
        status: 'OPEN',
        assignedToId: staffId.storekeeper,
        purchaseId: 'missing',
      }).expect(400);
      expect(messageOf(missing)).toBe(OPEN_PURCHASE_MESSAGE);

      const open = await purchase();
      const linked = await raise('manager', {
        title: 'Buy stock',
        type: 'PURCHASE',
        assignedToId: staffId.storekeeper,
        purchaseId: open.id,
        maintenanceId: 'ignored',
      });
      expect(linked).toMatchObject({
        purchaseId: open.id,
        purchaseNumber: open.number,
        maintenanceId: null,
      });

      // A rejected requisition is closed to new links, but a task already
      // linked to it keeps its link through a manager's edit.
      await request(server())
        .post(`/api/v1/staff/purchases/${open.id}/reject`)
        .set(as('manager2'))
        .send({ version: open.version })
        .expect(200);

      const closed = await create('manager', {
        title: 'Chase the vendor',
        type: 'PURCHASE',
        status: 'OPEN',
        assignedToId: staffId.storekeeper,
        purchaseId: open.id,
      }).expect(400);
      expect(messageOf(closed)).toBe(OPEN_PURCHASE_MESSAGE);

      const kept = (
        await save('manager', linked, { title: 'Buy stock elsewhere' }).expect(
          200,
        )
      ).body as Task;
      expect(kept).toMatchObject({
        title: 'Buy stock elsewhere',
        purchaseId: open.id,
      });
    });

    it('maintenance tasks must link an open repair', async () => {
      const missing = await create('manager', {
        title: 'Follow up repair',
        type: 'MAINTENANCE',
        status: 'OPEN',
        assignedToId: staffId.reception,
      }).expect(400);
      expect(messageOf(missing)).toBe(OPEN_MAINTENANCE_MESSAGE);

      const fixed = await create('manager', {
        title: 'Follow up repair',
        type: 'MAINTENANCE',
        status: 'OPEN',
        assignedToId: staffId.reception,
        maintenanceId: await repair(MaintenanceStatus.FIXED),
      }).expect(400);
      expect(messageOf(fixed)).toBe(OPEN_MAINTENANCE_MESSAGE);

      const repairId = await repair(MaintenanceStatus.IN_PROGRESS);
      const task = await raise('manager', {
        title: 'Follow up repair',
        type: 'MAINTENANCE',
        assignedToId: staffId.reception,
        maintenanceId: repairId,
      });
      expect(task.maintenanceId).toBe(repairId);
      expect(task.maintenanceNumber).toMatch(/^MT-\d{6}$/);

      // A manager changing the type drops the link the new type does not name.
      const general = (
        await save('manager', task, {
          type: 'GENERAL',
          maintenanceId: repairId,
        }).expect(200)
      ).body as Task;
      expect(general).toMatchObject({
        type: TaskType.GENERAL,
        maintenanceId: null,
        purchaseId: null,
      });
    });
  });

  describe('saving a task that exists', () => {
    it('task edits retain identity and maintenance links', async () => {
      const repairId = await repair(MaintenanceStatus.PENDING);
      const old = await raise('manager', {
        title: 'Follow up repair',
        type: 'MAINTENANCE',
        assignedToId: staffId.reception,
        maintenanceId: repairId,
      });

      const saved = (
        await save('reception', old, { status: 'IN_PROGRESS' }).expect(200)
      ).body as Task;
      expect(saved).toMatchObject({
        id: old.id,
        number: old.number,
        status: TaskStatus.IN_PROGRESS,
        maintenanceId: repairId,
        version: old.version + 1,
      });
    });

    it('assigned staff may save task status but cannot change assignment or record links', async () => {
      const repairId = await repair(MaintenanceStatus.PENDING);
      let task = await raise('manager', {
        title: 'Follow up repair POS1',
        type: 'MAINTENANCE',
        assignedToId: staffId.reception,
        maintenanceId: repairId,
      });

      task = (
        await save('reception', task, { status: 'IN_PROGRESS' }).expect(200)
      ).body as Task;
      expect(task.status).toBe(TaskStatus.IN_PROGRESS);

      // D42's role gate: a Waiter has no Tasks page at all.
      const waiter = await save('waiter', task, { status: 'DONE' }).expect(403);
      expect(messageOf(waiter)).toBe(ROLE_REFUSED_MESSAGE);

      const cases: [Actor, Record<string, unknown>, string][] = [
        ['kitchen', { status: 'DONE' }, ASSIGNED_ONLY_MESSAGE],
        ['reception', { title: 'Something else' }, MANAGER_DETAILS_MESSAGE],
        [
          'reception',
          { assignedToId: staffId.manager },
          MANAGER_REASSIGN_MESSAGE,
        ],
        [
          'reception',
          { maintenanceId: 'OTHER', status: 'DONE' },
          MANAGER_LINKS_MESSAGE,
        ],
        ['reception', { type: 'GENERAL' }, MANAGER_LINKS_MESSAGE],
      ];

      for (const [actor, changes, message] of cases) {
        const response = await save(actor, task, changes).expect(403);
        expect(messageOf(response)).toBe(message);
      }

      // The screen's Start / Mark Done button may leave the assignee out.
      task = (
        await save('reception', task, {
          status: 'DONE',
          assignedToId: undefined,
        }).expect(200)
      ).body as Task;
      expect(task.history.map((step) => step.status)).toEqual([
        TaskStatus.OPEN,
        TaskStatus.IN_PROGRESS,
        TaskStatus.DONE,
      ]);
      expect(task.history.at(-1)).toMatchObject({
        staffId: staffId.reception,
        staffName: 'Tasks reception',
        automatic: false,
      });

      const stale = await save(
        'reception',
        { ...task, version: task.version - 1 },
        { status: 'OPEN' },
      ).expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);
    });

    it('lets a manager edit, reassign and move any task, and records each save', async () => {
      let task = await raise('kitchen', {
        title: 'Hood filter',
        assignedToId: staffId.manager,
      });

      task = (
        await save('manager2', task, {
          title: 'Replace the hood filter',
          assignedToId: staffId.kitchen,
          status: 'IN_PROGRESS',
        }).expect(200)
      ).body as Task;
      expect(task).toMatchObject({
        title: 'Replace the hood filter',
        assignedToId: staffId.kitchen,
        status: TaskStatus.IN_PROGRESS,
        raisedById: staffId.kitchen,
      });

      const toWaiter = await save('manager2', task, {
        assignedToId: staffId.waiter,
      }).expect(400);
      expect(messageOf(toWaiter)).toBe(ASSIGNEE_MESSAGE);

      const missing = await request(server())
        .patch('/api/v1/staff/tasks/missing')
        .set(as('manager'))
        .send({
          version: 0,
          title: 'x',
          type: 'GENERAL',
          status: 'OPEN',
          assignedToId: staffId.kitchen,
        })
        .expect(404);
      expect(messageOf(missing)).toBe(TASK_NOT_FOUND_MESSAGE);

      const audit = await prisma.auditLog.findMany({
        where: { ref: task.number },
        select: { action: true, staffId: true },
        orderBy: { at: 'asc' },
      });
      expect(audit).toEqual([
        { action: 'task.save', staffId: staffId.kitchen },
        { action: 'task.save', staffId: staffId.manager2 },
      ]);
    });
  });

  describe('the automatic tasks', () => {
    it('shows the Storekeeper the receive task but not the review their purchase raised, and closes it on receipt', async () => {
      const p = await purchase();

      const reviewTask = (await read('manager')).data.find(
        (task) => task.purchaseId === p.id,
      )!;
      expect(reviewTask).toMatchObject({
        automatic: true,
        assignedToId: staffId.manager,
        raisedById: staffId.storekeeper,
        status: TaskStatus.OPEN,
      });
      expect(
        (await read('storekeeper')).data.some(
          (task) => task.id === reviewTask.id,
        ),
      ).toBe(false);

      await request(server())
        .post(`/api/v1/staff/purchases/${p.id}/approve`)
        .set(as('owner'))
        .send({ version: p.version })
        .expect(200);

      let receiveTask = (await read('storekeeper')).data.find(
        (task) => task.purchaseId === p.id,
      )!;
      expect(receiveTask).toMatchObject({
        automatic: true,
        assignedToId: staffId.storekeeper,
        status: TaskStatus.OPEN,
      });

      receiveTask = (
        await save('storekeeper', receiveTask, {
          status: 'IN_PROGRESS',
        }).expect(200)
      ).body as Task;

      await request(server())
        .post(`/api/v1/staff/purchases/${p.id}/receive`)
        .set(as('storekeeper'))
        .send({ version: p.version + 1 })
        .expect(200);

      const closed = (await read('storekeeper')).data.find(
        (task) => task.id === receiveTask.id,
      )!;
      expect(closed.status).toBe(TaskStatus.DONE);
      expect(closed.history.at(-1)).toMatchObject({
        status: TaskStatus.DONE,
        automatic: true,
      });

      // A save from the screen read before the receipt is stale.
      const stale = await save('storekeeper', receiveTask, {
        status: 'DONE',
      }).expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);
    });
  });

  describe('the read, the history and the bell', () => {
    it('shows each person their own and raised tasks, and managers all, Open first', async () => {
      const mine = await raise('manager', {
        title: 'Reception: stock the menus',
        assignedToId: staffId.reception,
      });
      const raised = await raise('reception', {
        title: 'Reception: the door sticks',
        assignedToId: staffId.manager,
      });
      const elsewhere = await raise('manager', {
        title: 'Kitchen: label the trays',
        assignedToId: staffId.kitchen,
      });
      await save('reception', mine, { status: 'DONE' }).expect(200);

      const page = await read('reception');
      const ids = page.data.map((task) => task.id);
      expect(ids).toEqual(expect.arrayContaining([mine.id, raised.id]));
      expect(ids).not.toContain(elsewhere.id);
      expect(
        page.data.every(
          (task) =>
            task.assignedToId === staffId.reception ||
            (task.raisedById === staffId.reception && !task.automatic),
        ),
      ).toBe(true);

      // Open, then In Progress, then Done.
      const order = { OPEN: 0, IN_PROGRESS: 1, DONE: 2 };
      const ranks = page.data.map((task) => order[task.status]);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(page.counts.open + page.counts.inProgress + page.counts.done).toBe(
        page.total,
      );

      const done = await read('reception', { status: 'DONE' });
      expect(done.data.map((task) => task.id)).toContain(mine.id);
      expect(done.data.every((task) => task.status === TaskStatus.DONE)).toBe(
        true,
      );
      expect(done.counts).toEqual(page.counts);

      const managers = await read('manager2');
      expect(managers.data.map((task) => task.id)).toEqual(
        expect.arrayContaining([mine.id, raised.id, elsewhere.id]),
      );

      const searched = await read('manager', { q: 'label the trays' });
      expect(searched.data.map((task) => task.id)).toEqual([elsewhere.id]);

      const bad = await request(server())
        .get('/api/v1/staff/tasks')
        .query({ status: 'LATER' })
        .set(as('reception'))
        .expect(400);
      expect(messageOf(bad)).toEqual([TASK_STATUS_FILTER_MESSAGE]);
    });

    it('lets a person read the history of the tasks they see, and no other', async () => {
      const task = await raise('manager', {
        title: 'Kitchen: deep clean',
        assignedToId: staffId.kitchen,
      });

      const history = (actor: Actor, ref: string = task.number) =>
        request(server())
          .get('/api/v1/staff/audit')
          .query({ ref })
          .set(as(actor));

      const response = await history('kitchen').expect(200);
      expect(
        (response.body as { data: { action: string }[] }).data.map(
          (row) => row.action,
        ),
      ).toEqual(['task.save']);

      for (const actor of ['reception', 'cashier', 'bartender'] as Actor[]) {
        await history(actor).expect(403);
      }

      await history('kitchen', 'T-999999999').expect(403);
    });

    it('staff notifications are relevant to the role and assigned tasks disappear when done', async () => {
      const task = await raise('manager', {
        title: 'Cashier: count the float',
        assignedToId: staffId.cashier,
      });

      const bell = async () =>
        (await readBell(server(), as('cashier'))).data.map((item) => item.id);

      expect(await bell()).toContain(`task:${task.id}`);
      await save('cashier', task, { status: 'DONE' }).expect(200);
      expect(await bell()).not.toContain(`task:${task.id}`);
    });
  });
});
