import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import {
  MaintenanceStatus,
  Prisma,
  PurchaseStatus,
  StaffRole,
  StockKind,
  StockLocation,
  StockRequestStatus,
  TaskType,
  WasteReason,
} from '../generated/cnc-client';
import { parseIsoDate } from '../src/common/calendar-date';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';
import { uniqueViolationTargets } from '../src/prisma/unique-violation';
import { latestPackCostKobo } from '../src/stock/stock-value';
import { createTestApp } from './create-test-app';
import { createStaffAccount } from './staff-fixtures';

/**
 * What the C5 core migration adds by hand, checked against Postgres: the
 * partial unique index that allows one open shift per person, and the
 * CHECKs on requests, vendors, purchase lines, waste, tasks, assets, repairs
 * and attendance. Prisma's schema says none of this, so a migration that
 * lost one would pass every other test. The latest pack cost read (C5-1
 * fills in C4's `latestPackCostKobo`) is checked here too, because it is a
 * join the unit test can only describe.
 *
 * Every row is run-unique and never removed.
 */
describe('C5 core schema (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  let staffId: string;
  let stockItemId: string;
  let vendorId: string;
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);

    staffId = (
      await createStaffAccount(prisma, StaffRole.STOREKEEPER, {
        emailPrefix: 'c5-schema',
      })
    ).id;
    stockItemId = (
      await prisma.stockItem.create({
        data: {
          name: `C5 Probe Rice ${tag}`,
          kind: StockKind.KITCHEN,
          unit: 'portion',
          pack: 'bag',
          factor: 50,
          minimum: 10,
        },
      })
    ).id;
    vendorId = (
      await prisma.vendor.create({
        data: { name: `Probe Vendor ${tag}`, phone: '08031234567' },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  /** The error a promise rejects with, or undefined. */
  const failureOf = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  const isoDate = (value: string): Date => {
    const date = parseIsoDate(value);
    if (date === null) throw new Error(`Not a date: ${value}`);
    return date;
  };

  describe('stock requests', () => {
    const requestRow = async (
      fields: Partial<Prisma.StockRequestUncheckedCreateInput> = {},
    ) =>
      prisma.stockRequest.create({
        data: {
          number: await drawNumber(prisma, 'stockRequest'),
          location: StockLocation.KITCHEN,
          stockItemId,
          qtyPacks: 2,
          createdById: staffId,
          ...fields,
        },
      });

    it('accepts each status with the packs it implies', async () => {
      await expect(requestRow()).resolves.toMatchObject({
        status: StockRequestStatus.PENDING,
      });
      await expect(
        requestRow({
          status: StockRequestStatus.PARTIALLY_ISSUED,
          issuedPacks: 1,
        }),
      ).resolves.toBeDefined();
      await expect(
        requestRow({ status: StockRequestStatus.ISSUED, issuedPacks: 2 }),
      ).resolves.toBeDefined();
      await expect(
        requestRow({
          status: StockRequestStatus.REJECTED,
          issuedPacks: 1,
          rejectReason: 'Out',
        }),
      ).resolves.toBeDefined();
    });

    it('refuses a request for the Store', async () => {
      await expect(
        requestRow({ location: StockLocation.STORE }),
      ).rejects.toThrow(/StockRequest_location_check/);
    });

    it('refuses no packs, and more sent than asked for', async () => {
      await expect(requestRow({ qtyPacks: 0 })).rejects.toThrow(
        /StockRequest_packs_check/,
      );
      await expect(
        requestRow({ status: StockRequestStatus.ISSUED, issuedPacks: 3 }),
      ).rejects.toThrow(/StockRequest_packs_check/);
    });

    it('holds the status to the packs sent', async () => {
      await expect(requestRow({ issuedPacks: 1 })).rejects.toThrow(
        /StockRequest_status_check/,
      );
      await expect(
        requestRow({ status: StockRequestStatus.ISSUED, issuedPacks: 1 }),
      ).rejects.toThrow(/StockRequest_status_check/);
      await expect(
        requestRow({
          status: StockRequestStatus.PARTIALLY_ISSUED,
          issuedPacks: 0,
        }),
      ).rejects.toThrow(/StockRequest_status_check/);
    });

    it('requires a reason exactly when Rejected', async () => {
      await expect(
        requestRow({ status: StockRequestStatus.REJECTED }),
      ).rejects.toThrow(/StockRequest_reject_check/);
      await expect(
        requestRow({
          status: StockRequestStatus.REJECTED,
          rejectReason: '  ',
        }),
      ).rejects.toThrow(/StockRequest_reject_check/);
      await expect(requestRow({ rejectReason: 'Why?' })).rejects.toThrow(
        /StockRequest_reject_check/,
      );
    });
  });

  describe('vendors, purchases and waste', () => {
    it('refuses a vendor without a name or a phone', async () => {
      await expect(
        prisma.vendor.create({ data: { name: ' ', phone: '0803' } }),
      ).rejects.toThrow(/Vendor_required_check/);
      await expect(
        prisma.vendor.create({ data: { name: 'Probe', phone: '' } }),
      ).rejects.toThrow(/Vendor_required_check/);
    });

    const purchase = async (status: PurchaseStatus = PurchaseStatus.PENDING) =>
      prisma.purchase.create({
        data: {
          number: await drawNumber(prisma, 'purchase'),
          vendorId,
          status,
          createdById: staffId,
        },
      });

    const line = (
      purchaseId: string,
      fields: Partial<Prisma.PurchaseLineUncheckedCreateInput> = {},
    ) =>
      prisma.purchaseLine.create({
        data: {
          purchaseId,
          position: 0,
          stockItemId,
          vendorId,
          qtyPacks: 2,
          costKobo: 7000000,
          ...fields,
        },
      });

    it('refuses a line of no packs, a cost of nothing, and more received than bought', async () => {
      const { id } = await purchase();

      await expect(line(id, { qtyPacks: 0 })).rejects.toThrow(
        /PurchaseLine_values_check/,
      );
      await expect(line(id, { costKobo: 0 })).rejects.toThrow(
        /PurchaseLine_values_check/,
      );
      await expect(line(id, { receivedPacks: 3 })).rejects.toThrow(
        /PurchaseLine_values_check/,
      );
    });

    it('refuses a second line for the same item on one purchase, as a clash on those fields', async () => {
      const { id } = await purchase();
      await line(id);

      expect(
        uniqueViolationTargets(await failureOf(line(id, { position: 1 }))),
      ).toEqual(['purchaseId', 'stockItemId']);
    });

    it('refuses waste of nothing and a negative value', async () => {
      const waste = async (qty: number, valueKobo: number) =>
        prisma.wasteEntry.create({
          data: {
            number: await drawNumber(prisma, 'waste'),
            location: StockLocation.KITCHEN,
            stockItemId,
            qty,
            reason: WasteReason.SPOILED,
            valueKobo,
            createdById: staffId,
          },
        });

      await expect(waste(1, 0)).resolves.toBeDefined();
      await expect(waste(0, 0)).rejects.toThrow(/WasteEntry_values_check/);
      await expect(waste(1, -1)).rejects.toThrow(/WasteEntry_values_check/);
    });

    it('reads the latest pack cost from the newest Approved or Fulfilled purchase only (C4’s latestPackCostKobo, Q25)', async () => {
      const item = (
        await prisma.stockItem.create({
          data: {
            name: `C5 Probe Beans ${tag}`,
            kind: StockKind.KITCHEN,
            unit: 'portion',
            pack: 'bag',
            factor: 40,
            minimum: 0,
          },
        })
      ).id;

      await expect(latestPackCostKobo(prisma, item)).resolves.toBeNull();

      const first = await purchase(PurchaseStatus.FULFILLED);
      await line(first.id, { stockItemId: item, costKobo: 600000 });
      await expect(latestPackCostKobo(prisma, item)).resolves.toBe(600000);

      const second = await purchase(PurchaseStatus.APPROVED);
      await line(second.id, { stockItemId: item, costKobo: 650000 });
      await expect(latestPackCostKobo(prisma, item)).resolves.toBe(650000);

      for (const status of [
        PurchaseStatus.PENDING,
        PurchaseStatus.REJECTED,
        PurchaseStatus.CANCELLED,
      ]) {
        const skipped = await purchase(status);
        await line(skipped.id, { stockItemId: item, costKobo: 9900000 });
      }
      await expect(latestPackCostKobo(prisma, item)).resolves.toBe(650000);
    });
  });

  describe('tasks, assets and repairs', () => {
    let assetId: string;

    beforeAll(async () => {
      assetId = (
        await prisma.asset.create({
          data: { tag: `PROBE-${tag}`, name: 'Probe fridge', quantity: 1 },
        })
      ).id;
    });

    const repair = async (
      fields: Partial<Prisma.MaintenanceRecordUncheckedCreateInput> = {},
    ) =>
      prisma.maintenanceRecord.create({
        data: {
          number: await drawNumber(prisma, 'maintenance'),
          assetId,
          vendorId,
          description: 'Door seal',
          reportedOn: isoDate('2031-03-10'),
          ...fields,
        },
      });

    const task = async (
      fields: Partial<Prisma.TaskUncheckedCreateInput> = {},
    ) =>
      prisma.task.create({
        data: {
          number: await drawNumber(prisma, 'task'),
          title: 'Probe task',
          type: TaskType.GENERAL,
          assignedToId: staffId,
          raisedById: staffId,
          ...fields,
        },
      });

    it('links a task only to the kind of record its type names', async () => {
      const record = await repair();
      const requisition = await prisma.purchase.create({
        data: {
          number: await drawNumber(prisma, 'purchase'),
          vendorId,
          createdById: staffId,
        },
      });

      await expect(
        task({ type: TaskType.MAINTENANCE, maintenanceId: record.id }),
      ).resolves.toBeDefined();
      await expect(
        task({ type: TaskType.PURCHASE, purchaseId: requisition.id }),
      ).resolves.toBeDefined();
      await expect(task({ purchaseId: requisition.id })).rejects.toThrow(
        /Task_values_check/,
      );
      await expect(
        task({ type: TaskType.PURCHASE, maintenanceId: record.id }),
      ).rejects.toThrow(/Task_values_check/);
      await expect(task({ title: '  ' })).rejects.toThrow(/Task_values_check/);
    });

    it('refuses an asset with no quantity and a second asset with the same tag', async () => {
      await expect(
        prisma.asset.create({
          data: { tag: `Q-${tag}`, name: 'Probe', quantity: 0 },
        }),
      ).rejects.toThrow(/Asset_values_check/);

      expect(
        uniqueViolationTargets(
          await failureOf(
            prisma.asset.create({
              data: { tag: `PROBE-${tag}`, name: 'Again', quantity: 1 },
            }),
          ),
        ),
      ).toEqual(['tag']);
    });

    it('requires a resolved date for a Fixed or Not Fixed repair, never before the report (R3)', async () => {
      await expect(repair({ status: MaintenanceStatus.FIXED })).rejects.toThrow(
        /MaintenanceRecord_values_check/,
      );
      await expect(
        repair({
          status: MaintenanceStatus.NOT_FIXED,
          resolvedOn: isoDate('2031-03-09'),
        }),
      ).rejects.toThrow(/MaintenanceRecord_values_check/);
      await expect(repair({ costKobo: -1 })).rejects.toThrow(
        /MaintenanceRecord_values_check/,
      );

      // Resolved once and moved back to In Progress: the date stays.
      await expect(
        repair({
          status: MaintenanceStatus.IN_PROGRESS,
          resolvedOn: isoDate('2031-03-12'),
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('attendance', () => {
    const shift = (forStaff: string, timeOut: Date | null = null) =>
      prisma.attendanceRecord.create({
        data: {
          staffId: forStaff,
          businessDate: isoDate('2031-04-01'),
          timeIn: new Date('2031-04-01T08:00:00.000Z'),
          timeOut,
        },
      });

    const freshPerson = async () =>
      (
        await createStaffAccount(prisma, StaffRole.CASHIER, {
          emailPrefix: 'c5-schema-shift',
        })
      ).id;

    it('refuses a second open shift for one person, as a clash on staffId', async () => {
      const person = await freshPerson();
      await shift(person);

      expect(uniqueViolationTargets(await failureOf(shift(person)))).toEqual([
        'staffId',
      ]);
    });

    it('allows any number of closed shifts beside one open one', async () => {
      const person = await freshPerson();
      await shift(person, new Date('2031-04-01T17:00:00.000Z'));
      await shift(person, new Date('2031-04-01T18:00:00.000Z'));

      await expect(shift(person)).resolves.toMatchObject({ timeOut: null });
    });

    it('lets two racing open shifts for one person commit only once', async () => {
      const person = await freshPerson();

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => shift(person)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('refuses a shift that ends before it began, and a correction without a reason', async () => {
      const person = await freshPerson();

      await expect(
        shift(person, new Date('2031-04-01T07:00:00.000Z')),
      ).rejects.toThrow(/AttendanceRecord_times_check/);

      const record = await shift(person, new Date('2031-04-01T16:00:00.000Z'));

      await expect(
        prisma.attendanceCorrection.create({
          data: {
            recordId: record.id,
            beforeIn: record.timeIn,
            beforeOut: record.timeOut,
            reason: ' ',
            staffId,
          },
        }),
      ).rejects.toThrow(/AttendanceCorrection_values_check/);
    });
  });
});
