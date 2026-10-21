import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Department,
  MenuCategoryKind,
  StaffRole,
  StockKind,
  StockLocation,
  StockMovementType,
} from '../generated/cnc-client';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { ADMIN_REASON_MESSAGE } from '../src/common/admin-reason';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import {
  LINES_DUPLICATE_MESSAGE,
  LINES_EMPTY_MESSAGE,
  LINES_QTY_MESSAGE,
} from '../src/common/command-lines';
import { watToday } from '../src/common/wat';
import { CrosscheckStatus } from '../src/kitchen/kitchen-crosscheck';
import {
  KITCHEN_CLOSE_TODAY_MESSAGE,
  KITCHEN_CLOSED_MESSAGE,
  KITCHEN_DATE_ASSIGNED_MESSAGE,
  KITCHEN_DATE_MESSAGE,
  KITCHEN_DUPLICATE_MESSAGE,
  KITCHEN_ENTRY_NOT_FOUND_MESSAGE,
  KITCHEN_FUTURE_MESSAGE,
  KITCHEN_LINES_MESSAGE,
  KITCHEN_ORDER_ASSIGNED_MESSAGE,
  KITCHEN_PORTION_MESSAGE,
  KITCHEN_REVISION_ASSIGNED_MESSAGE,
} from '../src/kitchen/kitchen-messages';
import { DOCKET_NOT_FOUND_MESSAGE } from '../src/orders/order-messages';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import { StockLedgerService } from '../src/stock/stock-ledger.service';
import { insufficientStockMessage } from '../src/stock/stock-messages';
import { createTestApp } from './create-test-app';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from './isolated-database';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

/**
 * The Kitchen (C4-6) through HTTP and against Postgres: kitchen entries
 * recorded against a docket number (`kitchen.save`), the stock they take
 * and return, the corrections only a manager may make, the kitchen day's
 * close (`kitchen.close`), and the Kitchen Crosscheck report.
 *
 * The demo's `domain.test.cjs` and `revision.test.cjs` kitchen cases are
 * ported by name. The C4 gate's step 3 ("the kitchen records portions
 * against the docket number; the crosscheck shows Matched") is the first
 * test.
 *
 * It runs on a database of its own (`createIsolatedDatabase`): closing
 * today's kitchen day is one row for the whole database, and the shared
 * test database is used by every suite on every run, so a close committed
 * there would turn every later kitchen save of the day into a manager's
 * correction. The crosscheck's totals then cover this suite's dockets only.
 * Opening balances go in through `StockLedgerService`, as a stock count
 * would put them (Q11). A docket from an earlier day is made by moving a
 * bill and its docket to yesterday directly, a state no route makes.
 */
describe('Kitchen entries, close day and crosscheck (e2e)', () => {
  let database: IsolatedDatabase;
  const originalUrl = process.env.CNC_DB_URL;

  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  const token: Partial<Record<StaffRole, string>> = {};
  const staffName: Partial<Record<StaffRole, string>> = {};

  let jollofId: string;
  let soupId: string;
  let riceId: string;
  let chickenId: string;
  let plantainId: string;
  let lagerStockId: string;

  const OPENING = 200;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    const ledger = app.get(StockLedgerService, { strict: false });
    const tokens = app.get(CncTokenService, { strict: false });

    await prisma.settings.createMany({ data: [{}], skipDuplicates: true });

    for (const role of [
      StaffRole.OWNER,
      StaffRole.MANAGER,
      StaffRole.KITCHEN,
      StaffRole.WAITER,
      StaffRole.CASHIER,
      StaffRole.BARTENDER,
    ]) {
      const made = await createStaffAccount(prisma, role, {
        emailPrefix: 'kitchen',
        name: `Kitchen suite ${role.toLowerCase()}`,
      });
      token[role] = await accessTokenFor(tokens, made.id);
      staffName[role] = made.name;
    }

    const menuCategory = await prisma.menuCategory.create({
      data: {
        slug: 'kitchen-food',
        title: 'Kitchen food',
        kind: MenuCategoryKind.FOOD,
        sort: 1,
      },
    });
    const staffCategory = await prisma.staffCategory.create({
      data: {
        name: 'Kitchen food',
        department: Department.RESTAURANT,
        menuCategoryId: menuCategory.id,
      },
    });
    const dish = (slug: string, name: string) =>
      prisma.menuItem.create({
        data: {
          slug,
          department: Department.RESTAURANT,
          menuCategoryId: menuCategory.id,
          staffCategoryId: staffCategory.id,
          name,
          priceKobo: 500000,
        },
      });
    jollofId = (await dish('jollof', 'Jollof Rice')).id;
    soupId = (await dish('egusi', 'Egusi Soup')).id;

    const portion = (name: string) =>
      prisma.stockItem.create({
        data: {
          name,
          kind: StockKind.KITCHEN,
          unit: 'portion',
          pack: 'tray',
          factor: 10,
          minimum: 15,
        },
      });
    riceId = (await portion('Rice')).id;
    chickenId = (await portion('Chicken')).id;
    plantainId = (await portion('Plantain')).id;

    // A drink and its paired Bar stock item: not a kitchen portion.
    const drinks = await prisma.menuCategory.create({
      data: {
        slug: 'kitchen-drinks',
        title: 'Kitchen drinks',
        kind: MenuCategoryKind.DRINKS,
        sort: 2,
      },
    });
    const bar = await prisma.staffCategory.create({
      data: {
        name: 'Kitchen drinks',
        department: Department.BAR,
        menuCategoryId: drinks.id,
      },
    });
    const lager = await prisma.menuItem.create({
      data: {
        slug: 'lager',
        department: Department.BAR,
        menuCategoryId: drinks.id,
        staffCategoryId: bar.id,
        name: 'Lager',
        priceKobo: 250000,
      },
    });
    lagerStockId = (
      await prisma.stockItem.create({
        data: {
          name: 'Lager',
          kind: StockKind.BAR,
          unit: 'serving',
          pack: 'batch',
          factor: 12,
          minimum: 12,
          menuItemId: lager.id,
        },
      })
    ).id;

    // Opening balances, as the C4 gate enters them by stock count (Q11).
    // Plantain is left at zero.
    await prisma.$transaction(async (tx) => {
      for (const stockItemId of [riceId, chickenId]) {
        await ledger.move(tx, {
          stockItemId,
          location: StockLocation.KITCHEN,
          qty: OPENING,
          type: StockMovementType.STOCK_COUNT,
          ref: 'Opening balance',
          staffId: null,
        });
      }
    });

    // Jollof's comparison rule: one rice and one chicken a plate.
    await request(app.getHttpServer())
      .put(`/api/v1/staff/kitchen-mappings/${jollofId}`)
      .set({ Authorization: `Bearer ${token[StaffRole.OWNER]}` })
      .send({
        lines: [
          { stockItemId: riceId, qty: 1 },
          { stockItemId: chickenId, qty: 1 },
        ],
      })
      .expect(200);
  }, 120_000);

  afterAll(async () => {
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const auth = (role: StaffRole) => ({
    Authorization: `Bearer ${token[role]}`,
  });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;
  /** The sentences of a 400, from the ValidationPipe (a list) or a service. */
  const sentencesOf = (response: request.Response) =>
    [messageOf(response)].flat();
  /** The statuses of racing requests, in order. */
  const statuses = (results: request.Response[]) =>
    results.map((result) => result.status).sort();
  /** The sentence the refused one of two racing requests was given. */
  const conflictOf = (results: request.Response[]) =>
    messageOf(results.find((result) => result.status === 409)!);
  const entriesFor = (docketRef: string) =>
    prisma.kitchenEntry.count({ where: { docketRef } });
  const today = () => formatIsoDate(watToday(new Date()));
  const yesterday = () => formatIsoDate(addDays(watToday(new Date()), -1));
  const tomorrow = () => formatIsoDate(addDays(watToday(new Date()), 1));

  interface Line {
    stockItemId: string;
    stockItemName: string;
    unit: string;
    qty: number;
  }

  interface Entry {
    id: string;
    docketRef: string;
    orderId: string;
    orderNumber: string;
    revision: number;
    businessDate: string;
    lines: Line[];
    staffName: string;
    version: number;
  }

  interface Bill {
    id: string;
    number: string;
    version: number;
  }

  interface Row {
    ref: string;
    orderNumber: string;
    businessDate: string;
    revision: number;
    kitchenRevision: number | null;
    status: CrosscheckStatus;
    expected: { stockItemId: string; stockItemName: string; qty: number }[];
    actual: { stockItemId: string; stockItemName: string; qty: number }[];
  }

  interface CrosscheckPage {
    data: Row[];
    total: number;
    notMatched: number;
    from: string;
    to: string;
  }

  type Body = Record<string, unknown>;

  /** A Restaurant bill with `qty` of a dish, sent to the kitchen. */
  const sentBill = async (
    menuItemId: string = jollofId,
    qty = 2,
  ): Promise<{ bill: Bill; ref: string }> => {
    const opened = (
      await request(server())
        .post('/api/v1/staff/orders')
        .set(auth(StaffRole.WAITER))
        .set('Idempotency-Key', randomUUID())
        .send({ department: Department.RESTAURANT })
        .expect(201)
    ).body as Bill;
    const withLine = await setLine(opened, menuItemId, qty);

    return confirm(withLine);
  };

  const setLine = async (
    bill: Bill,
    menuItemId: string,
    qty: number,
  ): Promise<Bill> =>
    (
      await request(server())
        .put(`/api/v1/staff/orders/${bill.id}/lines`)
        .set(auth(StaffRole.WAITER))
        .send({ version: bill.version, menuItemId, qty })
        .expect(200)
    ).body as Bill;

  const confirm = async (bill: Bill): Promise<{ bill: Bill; ref: string }> => {
    const body = (
      await request(server())
        .post(`/api/v1/staff/orders/${bill.id}/confirm`)
        .set(auth(StaffRole.WAITER))
        .send({ version: bill.version })
        .expect(200)
    ).body as { order: Bill; docket: { ref: string } };

    return { bill: body.order, ref: body.docket.ref };
  };

  const save = (role: StaffRole, ref: string, body: Body) =>
    request(server())
      .put(`/api/v1/staff/kitchen/entries/${encodeURIComponent(ref)}`)
      .set(auth(role))
      .send(body);

  const portions = (rice: number, chicken: number) =>
    [
      rice > 0 ? { stockItemId: riceId, qty: rice } : null,
      chicken > 0 ? { stockItemId: chickenId, qty: chicken } : null,
    ].filter((line) => line !== null);

  const kitchenBalance = async (stockItemId: string) =>
    (
      await prisma.stockBalance.findUnique({
        where: {
          stockItemId_location: {
            stockItemId,
            location: StockLocation.KITCHEN,
          },
        },
        select: { qty: true },
      })
    )?.qty ?? 0;

  const crosscheck = async (query = ''): Promise<CrosscheckPage> =>
    (
      await request(server())
        .get(`/api/v1/staff/reports/kitchen-crosscheck${query}`)
        .set(auth(StaffRole.OWNER))
        .expect(200)
    ).body as CrosscheckPage;

  const rowFor = async (ref: string): Promise<Row | undefined> =>
    (await crosscheck('?pageSize=100')).data.find((row) => row.ref === ref);

  /** Move a bill and every revision of its docket to yesterday. */
  const carryToYesterday = async (bill: Bill) => {
    const date = addDays(watToday(new Date()), -1);

    await prisma.order.update({
      where: { id: bill.id },
      data: { businessDate: date },
    });
    await prisma.docket.updateMany({
      where: { orderId: bill.id },
      data: { businessDate: date },
    });
  };

  describe('kitchen.save', () => {
    it('records portions against the docket number, and the crosscheck shows Matched (C4 gate, step 3)', async () => {
      const { bill, ref } = await sentBill(jollofId, 2);
      const rice = await kitchenBalance(riceId);
      const chicken = await kitchenBalance(chickenId);

      // Typed from paper: any case, stray spaces.
      const response = await save(
        StaffRole.KITCHEN,
        `  ${ref.toLowerCase()} `,
        { lines: portions(2, 2) },
      ).expect(200);
      const entry = response.body as Entry;

      expect(entry).toMatchObject({
        docketRef: ref,
        orderId: bill.id,
        orderNumber: bill.number,
        revision: 1,
        businessDate: today(),
        staffName: staffName[StaffRole.KITCHEN],
        version: 0,
      });
      expect(entry.lines).toEqual([
        { stockItemId: riceId, stockItemName: 'Rice', unit: 'portion', qty: 2 },
        {
          stockItemId: chickenId,
          stockItemName: 'Chicken',
          unit: 'portion',
          qty: 2,
        },
      ]);
      expect(await kitchenBalance(riceId)).toBe(rice - 2);
      expect(await kitchenBalance(chickenId)).toBe(chicken - 2);

      const movements = await prisma.stockMovement.findMany({
        where: { ref, location: StockLocation.KITCHEN },
        select: { stockItemId: true, qty: true, type: true },
      });
      expect(movements).toHaveLength(2);
      for (const movement of movements) {
        expect(movement).toMatchObject({
          qty: -2,
          type: StockMovementType.KITCHEN_ENTRY,
        });
      }

      const row = await rowFor(ref);
      expect(row).toMatchObject({
        orderNumber: bill.number,
        revision: 1,
        kitchenRevision: 1,
        status: CrosscheckStatus.MATCHED,
      });
      expect(row?.expected).toEqual([
        { stockItemId: riceId, stockItemName: 'Rice', qty: 2 },
        { stockItemId: chickenId, stockItemName: 'Chicken', qty: 2 },
      ]);
    });

    it('kitchen derives order date and newest revision from one docket number', async () => {
      const first = await sentBill(jollofId, 2);
      const entry = (
        await save(StaffRole.KITCHEN, first.ref, {
          lines: portions(2, 2),
        }).expect(200)
      ).body as Entry;

      const changed = await setLine(first.bill, jollofId, 1);
      await confirm(changed);

      const saved = (
        await save(StaffRole.KITCHEN, first.ref, {
          version: entry.version,
          lines: [{ stockItemId: riceId, qty: 1 }],
        }).expect(200)
      ).body as Entry;

      expect(saved).toMatchObject({
        revision: 2,
        businessDate: today(),
        orderNumber: first.bill.number,
        version: entry.version + 1,
      });

      const refusals: [Body, string][] = [
        [{ date: yesterday() }, KITCHEN_DATE_ASSIGNED_MESSAGE],
        [{ revision: 99 }, KITCHEN_REVISION_ASSIGNED_MESSAGE],
        [{ orderNumber: 'WRONG' }, KITCHEN_ORDER_ASSIGNED_MESSAGE],
      ];

      for (const [extra, message] of refusals) {
        const refused = await save(StaffRole.KITCHEN, first.ref, {
          version: saved.version,
          lines: [{ stockItemId: riceId, qty: 1 }],
          ...extra,
        }).expect(400);
        expect(messageOf(refused)).toBe(message);
      }

      // The system's own values are accepted when sent back unchanged.
      await save(StaffRole.KITCHEN, first.ref, {
        version: saved.version,
        lines: [{ stockItemId: riceId, qty: 1 }],
        date: today(),
        revision: 2,
        orderNumber: first.bill.number,
      }).expect(200);

      const unknown = await save(StaffRole.KITCHEN, 'KOT-UNKNOWN', {
        lines: [],
      }).expect(404);
      expect(messageOf(unknown)).toBe(DOCKET_NOT_FOUND_MESSAGE);
    });

    it('kitchen correction returns only removed portions, and can clear a cancelled docket', async () => {
      const { bill, ref } = await sentBill(jollofId, 2);
      const entry = (
        await save(StaffRole.KITCHEN, ref, { lines: portions(2, 2) }).expect(
          200,
        )
      ).body as Entry;
      const rice = await kitchenBalance(riceId);
      const chicken = await kitchenBalance(chickenId);

      const corrected = (
        await save(StaffRole.KITCHEN, ref, {
          version: entry.version,
          lines: [{ stockItemId: riceId, qty: 1 }],
        }).expect(200)
      ).body as Entry;
      expect(await kitchenBalance(riceId)).toBe(rice + 1);
      expect(await kitchenBalance(chickenId)).toBe(chicken + 2);

      // The bill is cancelled: the kitchen's paper gets an empty revision.
      const cancelled = await request(server())
        .post(`/api/v1/staff/orders/${bill.id}/cancel`)
        .set(auth(StaffRole.MANAGER))
        .send({ version: bill.version, reason: 'Guest cancellation' })
        .expect(200);
      expect(
        (cancelled.body as { docket: { revision: number } }).docket.revision,
      ).toBe(2);
      expect((await rowFor(ref))?.status).toBe(
        CrosscheckStatus.REVISION_MISMATCH,
      );

      const cleared = (
        await save(StaffRole.KITCHEN, ref, {
          version: corrected.version,
          lines: [],
        }).expect(200)
      ).body as Entry;
      expect(cleared.lines).toEqual([]);
      expect(cleared.revision).toBe(2);
      expect(await kitchenBalance(riceId)).toBe(rice + 2);
      expect(await kitchenBalance(chickenId)).toBe(chicken + 2);

      const types = await prisma.stockMovement.findMany({
        where: { ref },
        select: { type: true },
      });
      expect(types.map((movement) => movement.type).sort()).toEqual(
        [
          StockMovementType.KITCHEN_ENTRY,
          StockMovementType.KITCHEN_ENTRY,
          StockMovementType.KITCHEN_CORRECTION,
          StockMovementType.KITCHEN_CORRECTION,
          StockMovementType.KITCHEN_CORRECTION,
        ].sort(),
      );
      expect((await rowFor(ref))?.status).toBe(CrosscheckStatus.MATCHED);
    });

    it('duplicate manual kitchen docket is rejected', async () => {
      const { ref } = await sentBill();
      await save(StaffRole.KITCHEN, ref, { lines: portions(2, 2) }).expect(200);
      const rice = await kitchenBalance(riceId);

      const duplicate = await save(StaffRole.KITCHEN, ref, {
        lines: portions(2, 2),
      }).expect(409);
      expect(messageOf(duplicate)).toBe(KITCHEN_DUPLICATE_MESSAGE);
      expect(await kitchenBalance(riceId)).toBe(rice);
    });

    it('two first entries for one docket at once: one is saved, the other refused, stock moves once', async () => {
      const { ref } = await sentBill();
      const rice = await kitchenBalance(riceId);

      const results = await Promise.all([
        save(StaffRole.KITCHEN, ref, { lines: portions(2, 2) }),
        save(StaffRole.KITCHEN, ref, { lines: portions(2, 2) }),
      ]);

      expect(statuses(results)).toEqual([200, 409]);
      expect(conflictOf(results)).toBe(KITCHEN_DUPLICATE_MESSAGE);
      expect(await kitchenBalance(riceId)).toBe(rice - 2);
      expect(await entriesFor(ref)).toBe(1);
    });

    it('two corrections naming one version: one is saved, the other is stale', async () => {
      const { ref } = await sentBill();
      const entry = (
        await save(StaffRole.KITCHEN, ref, { lines: portions(2, 2) }).expect(
          200,
        )
      ).body as Entry;
      const rice = await kitchenBalance(riceId);

      const results = await Promise.all([
        save(StaffRole.KITCHEN, ref, {
          version: entry.version,
          lines: portions(1, 2),
        }),
        save(StaffRole.KITCHEN, ref, {
          version: entry.version,
          lines: portions(1, 2),
        }),
      ]);

      expect(statuses(results)).toEqual([200, 409]);
      expect(conflictOf(results)).toBe(STALE_VERSION_MESSAGE);
      expect(await kitchenBalance(riceId)).toBe(rice + 1);

      const unknown = await save(StaffRole.KITCHEN, (await sentBill()).ref, {
        version: 0,
        lines: portions(1, 1),
      }).expect(404);
      expect(messageOf(unknown)).toBe(KITCHEN_ENTRY_NOT_FOUND_MESSAGE);
    });

    it('refuses a portion list it cannot record, with the demo’s sentences', async () => {
      const { ref } = await sentBill();
      const cases: [unknown, string][] = [
        [undefined, KITCHEN_LINES_MESSAGE],
        ['rice', KITCHEN_LINES_MESSAGE],
        [[], LINES_EMPTY_MESSAGE],
        [
          [
            { stockItemId: riceId, qty: 1 },
            { stockItemId: riceId, qty: 2 },
          ],
          LINES_DUPLICATE_MESSAGE,
        ],
        [[{ stockItemId: riceId, qty: 0 }], LINES_QTY_MESSAGE],
        [[{ stockItemId: riceId, qty: 1.5 }], LINES_QTY_MESSAGE],
        [[{ stockItemId: lagerStockId, qty: 1 }], KITCHEN_PORTION_MESSAGE],
        [[{ stockItemId: 'no-such-item', qty: 1 }], KITCHEN_PORTION_MESSAGE],
        [[{ qty: 1 }], KITCHEN_PORTION_MESSAGE],
      ];

      for (const [lines, message] of cases) {
        const refused = await save(StaffRole.KITCHEN, ref, { lines }).expect(
          400,
        );
        expect(sentencesOf(refused)).toEqual([message]);
      }

      expect(await entriesFor(ref)).toBe(0);
    });

    it('refuses portions the kitchen does not hold, and saves nothing', async () => {
      const { ref } = await sentBill();
      const rice = await kitchenBalance(riceId);

      const refused = await save(StaffRole.KITCHEN, ref, {
        lines: [
          { stockItemId: riceId, qty: 1 },
          { stockItemId: plantainId, qty: 1 },
        ],
      }).expect(409);

      expect(messageOf(refused)).toBe(
        insufficientStockMessage(StockLocation.KITCHEN, 'Plantain'),
      );
      expect(await kitchenBalance(riceId)).toBe(rice);
      expect(await entriesFor(ref)).toBe(0);
    });

    it('only the Kitchen and managers record portions', async () => {
      const { ref } = await sentBill();

      for (const role of [
        StaffRole.WAITER,
        StaffRole.CASHIER,
        StaffRole.BARTENDER,
      ]) {
        const refused = await save(role, ref, {
          lines: portions(1, 1),
        }).expect(403);
        expect(messageOf(refused)).toBe(ROLE_REFUSED_MESSAGE);

        await request(server())
          .get('/api/v1/staff/kitchen/entries')
          .set(auth(role))
          .expect(403);
      }

      await save(StaffRole.MANAGER, ref, { lines: portions(1, 1) }).expect(200);
    });

    it('a previous day’s docket needs a manager’s correction with a reason', async () => {
      const { bill, ref } = await sentBill();
      await carryToYesterday(bill);

      const kitchen = await save(StaffRole.KITCHEN, ref, {
        lines: portions(2, 2),
      }).expect(403);
      expect(messageOf(kitchen)).toBe(ROLE_REFUSED_MESSAGE);

      const noReason = await save(StaffRole.MANAGER, ref, {
        lines: portions(2, 2),
      }).expect(400);
      expect(messageOf(noReason)).toBe(ADMIN_REASON_MESSAGE);

      const saved = (
        await save(StaffRole.MANAGER, ref, {
          lines: portions(2, 2),
          reason: 'Late entry from paper',
        }).expect(200)
      ).body as Entry;
      expect(saved.businessDate).toBe(yesterday());

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'kitchen.save', ref },
        orderBy: { at: 'desc' },
        select: { reason: true },
      });
      expect(audit.reason).toBe('Late entry from paper');

      // A later edit of yesterday's entry is a correction too.
      const later = await save(StaffRole.KITCHEN, ref, {
        version: saved.version,
        lines: portions(1, 1),
      }).expect(403);
      expect(messageOf(later)).toBe(ROLE_REFUSED_MESSAGE);
    });

    it('manager kitchen date correction always requires a reason', async () => {
      const { ref } = await sentBill();
      const entry = (
        await save(StaffRole.KITCHEN, ref, { lines: portions(2, 2) }).expect(
          200,
        )
      ).body as Entry;

      const noReason = await save(StaffRole.MANAGER, ref, {
        version: entry.version,
        date: yesterday(),
        lines: portions(2, 2),
      }).expect(400);
      expect(messageOf(noReason)).toBe(ADMIN_REASON_MESSAGE);

      const moved = (
        await save(StaffRole.MANAGER, ref, {
          version: entry.version,
          date: yesterday(),
          lines: portions(2, 2),
          reason: 'Date correction',
        }).expect(200)
      ).body as Entry;
      expect(moved.businessDate).toBe(yesterday());

      const future = await save(StaffRole.MANAGER, ref, {
        version: moved.version,
        date: tomorrow(),
        lines: portions(2, 2),
        reason: 'Wrong',
      }).expect(400);
      expect(messageOf(future)).toBe(KITCHEN_FUTURE_MESSAGE);

      const invalid = await save(StaffRole.MANAGER, ref, {
        version: moved.version,
        date: '2026-02-30',
        lines: portions(2, 2),
        reason: 'Wrong',
      }).expect(400);
      expect(sentencesOf(invalid)).toEqual([KITCHEN_DATE_MESSAGE]);

      const history = await request(server())
        .get('/api/v1/staff/audit')
        .query({ ref })
        .set(auth(StaffRole.KITCHEN))
        .expect(200);
      const rows = (
        history.body as {
          data: { action: string; reason: string | null; changes: string[] }[];
        }
      ).data;
      const correction = rows.find((row) => row.reason === 'Date correction');
      expect(correction?.action).toBe('kitchen.save');
      expect(correction?.changes).toContain(
        `Business Date changed from ${today()} to ${yesterday()}.`,
      );
    });
  });

  describe('reads', () => {
    it('lists a kitchen date’s entries, searched by docket or order, with the portions recorded', async () => {
      const { bill, ref } = await sentBill(jollofId, 3);
      await save(StaffRole.KITCHEN, ref, { lines: portions(3, 3) }).expect(200);

      const all = (
        await request(server())
          .get('/api/v1/staff/kitchen/entries')
          .query({ pageSize: 100 })
          .set(auth(StaffRole.KITCHEN))
          .expect(200)
      ).body as { data: Entry[]; total: number; portions: number };
      expect(all.data.map((entry) => entry.docketRef)).toContain(ref);
      expect(all.data.every((entry) => entry.businessDate === today())).toBe(
        true,
      );
      expect(all.portions).toBe(
        all.data
          .flatMap((entry) => entry.lines)
          .reduce((sum, line) => sum + line.qty, 0),
      );

      const found = (
        await request(server())
          .get('/api/v1/staff/kitchen/entries')
          .query({ date: today(), q: bill.number.toLowerCase() })
          .set(auth(StaffRole.KITCHEN))
          .expect(200)
      ).body as { data: Entry[]; total: number; portions: number };
      expect(found).toMatchObject({ total: 1, portions: 6 });
      expect(found.data[0].docketRef).toBe(ref);
    });

    it('answers whether a kitchen day is locked', async () => {
      const open = await request(server())
        .get(`/api/v1/staff/kitchen/days/${today()}`)
        .set(auth(StaffRole.KITCHEN))
        .expect(200);
      expect(open.body).toMatchObject({
        businessDate: today(),
        closed: false,
        locked: false,
      });

      const earlier = await request(server())
        .get(`/api/v1/staff/kitchen/days/${yesterday()}`)
        .set(auth(StaffRole.KITCHEN))
        .expect(200);
      expect(earlier.body).toMatchObject({ closed: false, locked: true });

      await request(server())
        .get('/api/v1/staff/kitchen/days/yesterday')
        .set(auth(StaffRole.KITCHEN))
        .expect(400);
    });
  });

  describe('Kitchen Crosscheck', () => {
    it('crosscheck distinguishes missing, revision and quantity mismatches', async () => {
      const { bill, ref } = await sentBill(jollofId, 2);
      expect((await rowFor(ref))?.status).toBe(
        CrosscheckStatus.MISSING_KITCHEN_ENTRY,
      );

      const entry = (
        await save(StaffRole.KITCHEN, ref, { lines: portions(2, 2) }).expect(
          200,
        )
      ).body as Entry;
      expect((await rowFor(ref))?.status).toBe(CrosscheckStatus.MATCHED);

      await confirm(await setLine(bill, jollofId, 1));
      expect(await rowFor(ref)).toMatchObject({
        revision: 2,
        kitchenRevision: 1,
        status: CrosscheckStatus.REVISION_MISMATCH,
      });

      await save(StaffRole.KITCHEN, ref, {
        version: entry.version,
        lines: [{ stockItemId: riceId, qty: 1 }],
      }).expect(200);
      const row = await rowFor(ref);
      expect(row?.status).toBe(CrosscheckStatus.QUANTITY_MISMATCH);
      expect(row?.expected).toEqual([
        { stockItemId: riceId, stockItemName: 'Rice', qty: 1 },
        { stockItemId: chickenId, stockItemName: 'Chicken', qty: 1 },
      ]);
      expect(row?.actual).toEqual([
        { stockItemId: riceId, stockItemName: 'Rice', qty: 1 },
      ]);
    });

    it('flags a dish without a comparison rule, never passes it', async () => {
      const { ref } = await sentBill(soupId, 1);
      await save(StaffRole.KITCHEN, ref, { lines: portions(1, 0) }).expect(200);

      expect((await rowFor(ref))?.status).toBe(
        CrosscheckStatus.MAPPING_REQUIRED,
      );
    });

    it('reads a business-date range and counts what is not matched', async () => {
      const { bill, ref } = await sentBill(jollofId, 1);
      await carryToYesterday(bill);

      const todayOnly = await crosscheck('?pageSize=100');
      expect(todayOnly.from).toBe(today());
      expect(todayOnly.to).toBe(today());
      expect(todayOnly.data.map((row) => row.ref)).not.toContain(ref);
      expect(todayOnly.notMatched).toBe(
        todayOnly.data.filter((row) => row.status !== CrosscheckStatus.MATCHED)
          .length,
      );

      const yesterdayOnly = await crosscheck(
        `?from=${yesterday()}&to=${yesterday()}&pageSize=100`,
      );
      expect(yesterdayOnly.data.find((row) => row.ref === ref)).toMatchObject({
        businessDate: yesterday(),
        status: CrosscheckStatus.MISSING_KITCHEN_ENTRY,
      });
      expect(
        yesterdayOnly.data.every((row) => row.businessDate === yesterday()),
      ).toBe(true);

      const both = await crosscheck(
        `?from=${yesterday()}&to=${today()}&pageSize=100`,
      );
      expect(both.total).toBe(todayOnly.total + yesterdayOnly.total);

      const firstPage = await crosscheck(
        `?from=${yesterday()}&to=${today()}&pageSize=1`,
      );
      expect(firstPage.data).toHaveLength(1);
      expect(firstPage.total).toBe(both.total);

      await request(server())
        .get('/api/v1/staff/reports/kitchen-crosscheck')
        .query({ from: today(), to: yesterday() })
        .set(auth(StaffRole.OWNER))
        .expect(400);
    });

    it('is a manager’s report', async () => {
      for (const role of [
        StaffRole.KITCHEN,
        StaffRole.CASHIER,
        StaffRole.WAITER,
      ]) {
        await request(server())
          .get('/api/v1/staff/reports/kitchen-crosscheck')
          .set(auth(role))
          .expect(403);
      }

      await request(server())
        .get('/api/v1/staff/reports/kitchen-crosscheck')
        .set(auth(StaffRole.MANAGER))
        .expect(200);
    });
  });

  // Last: closing today makes every later save of today a correction.
  describe('kitchen.close', () => {
    it('closes the current day only, once, and a closed day needs logged manager corrections', async () => {
      const { ref } = await sentBill();
      const entry = (
        await save(StaffRole.KITCHEN, ref, { lines: portions(2, 2) }).expect(
          200,
        )
      ).body as Entry;

      for (const date of [yesterday(), tomorrow(), 'today']) {
        const refused = await request(server())
          .post(`/api/v1/staff/kitchen/days/${date}/close`)
          .set(auth(StaffRole.KITCHEN))
          .expect(400);
        expect(messageOf(refused)).toBe(KITCHEN_CLOSE_TODAY_MESSAGE);
      }

      await request(server())
        .post(`/api/v1/staff/kitchen/days/${today()}/close`)
        .set(auth(StaffRole.WAITER))
        .expect(403);

      // Two closes at once: one closes the day, the other is told it is.
      const results = await Promise.all([
        request(server())
          .post(`/api/v1/staff/kitchen/days/${today()}/close`)
          .set(auth(StaffRole.KITCHEN)),
        request(server())
          .post(`/api/v1/staff/kitchen/days/${today()}/close`)
          .set(auth(StaffRole.KITCHEN)),
      ]);
      expect(statuses(results)).toEqual([200, 409]);
      expect(conflictOf(results)).toBe(KITCHEN_CLOSED_MESSAGE);
      expect(
        results.find((result) => result.status === 200)!.body,
      ).toMatchObject({
        businessDate: today(),
        closed: true,
        closedByName: staffName[StaffRole.KITCHEN],
        locked: true,
      });

      const audit = await prisma.auditLog.findMany({
        where: { action: 'kitchen.close', ref: today() },
      });
      expect(audit).toHaveLength(1);

      // The kitchen may no longer record or correct today's dockets.
      const kitchen = await save(StaffRole.KITCHEN, ref, {
        version: entry.version,
        lines: portions(1, 1),
      }).expect(403);
      expect(messageOf(kitchen)).toBe(ROLE_REFUSED_MESSAGE);

      const fresh = await sentBill();
      await save(StaffRole.KITCHEN, fresh.ref, {
        lines: portions(1, 1),
      }).expect(403);

      const noReason = await save(StaffRole.MANAGER, ref, {
        version: entry.version,
        lines: portions(1, 1),
      }).expect(400);
      expect(messageOf(noReason)).toBe(ADMIN_REASON_MESSAGE);

      await save(StaffRole.MANAGER, ref, {
        version: entry.version,
        lines: portions(1, 1),
        reason: 'Approved stock correction',
      }).expect(200);
      const last = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'kitchen.save', ref },
        orderBy: { at: 'desc' },
        select: { reason: true },
      });
      expect(last.reason).toBe('Approved stock correction');
    });
  });
});
