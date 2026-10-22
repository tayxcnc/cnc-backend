import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import {
  Department,
  MenuCategoryKind,
  OrderStatus,
  Prisma,
  ReservationSource,
  ReservationStatus,
  StaffRole,
  StockKind,
  StockLocation,
  StockMovementType,
  TableKind,
  TableSessionStatus,
} from '../generated/cnc-client';
import { parseIsoDate } from '../src/common/calendar-date';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';
import { uniqueViolationTargets } from '../src/prisma/unique-violation';
import { createTestApp } from './create-test-app';
import { createStaffAccount } from './staff-fixtures';

/**
 * What the C4 core migration adds by hand, checked against Postgres: the two
 * partial unique indexes that make a double booking and a double table
 * allocation impossible, the append-only trigger on stock movements, and the
 * CHECKs on bills, lines, payments, reservations and sessions. Prisma's
 * schema says none of this, so a migration that lost one would pass every
 * other test.
 *
 * Every row is run-unique (its own room, table, dish and stock item) and
 * never removed. Anything that changes the schema (dropping the trigger to
 * watch the guard go) happens inside a transaction that is rolled back.
 */
describe('C4 core schema (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  let tableId: string;
  let staffId: string;
  let menuItemId: string;
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);

    const venue = await prisma.venue.create({
      data: {
        slug: `probe-${tag}`,
        customerTitle: `Probe ${tag}`,
        staffName: `Probe ${tag}`,
        bigParty: 4,
        sort: 900,
      },
    });
    tableId = (
      await prisma.diningTable.create({
        data: {
          venueId: venue.id,
          code: 'P1',
          name: 'Probe 1',
          kind: TableKind.DINING,
          capacity: 4,
        },
      })
    ).id;

    staffId = (
      await createStaffAccount(prisma, StaffRole.RECEPTION, {
        emailPrefix: 'c4-schema',
      })
    ).id;

    const menuCategory = await prisma.menuCategory.create({
      data: {
        slug: `probe-${tag}`,
        title: `Probe ${tag}`,
        kind: MenuCategoryKind.FOOD,
        sort: 900,
      },
    });
    const staffCategory = await prisma.staffCategory.create({
      data: {
        name: `Probe ${tag}`,
        department: Department.RESTAURANT,
        menuCategoryId: menuCategory.id,
      },
    });
    menuItemId = (
      await prisma.menuItem.create({
        data: {
          slug: `probe-dish-${tag}`,
          department: Department.RESTAURANT,
          staffCategoryId: staffCategory.id,
          menuCategoryId: menuCategory.id,
          name: `Probe Dish ${tag}`,
          priceKobo: 100000,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Run `work` in a transaction that is always rolled back. */
  async function inRolledBack(
    work: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    const ROLLBACK = new Error('rollback');

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
        await work(tx);
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
  }

  /** A business date from `YYYY-MM-DD`. */
  const isoDate = (value: string): Date => {
    const date = parseIsoDate(value);
    if (date === null) throw new Error(`Not a date: ${value}`);
    return date;
  };

  /** The error a promise rejects with, or undefined. */
  const failureOf = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  describe('one active booking per table per date', () => {
    let day = 0;

    /** A date of its own for each test, so they never meet. */
    const nextDate = () => {
      day += 1;
      return isoDate(`2031-0${1 + (day % 9)}-1${day % 10}`);
    };

    const booking = async (
      businessDate: Date,
      status: ReservationStatus = ReservationStatus.CONFIRMED,
    ) =>
      prisma.reservation.create({
        data: {
          number: await drawNumber(prisma, 'reservation'),
          tableId,
          name: 'Probe Guest',
          phone: '08031234567',
          businessDate,
          startMinutes: 720,
          party: 2,
          status,
          source: ReservationSource.RECEPTION,
          cancelledAt:
            status === ReservationStatus.CANCELLED ? new Date() : null,
        },
      });

    it('refuses a second confirmed booking for the same table and date, as a clash on those fields', async () => {
      const date = nextDate();
      await booking(date);

      const clash = await failureOf(booking(date));

      expect(clash).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(uniqueViolationTargets(clash)).toEqual([
        'tableId',
        'businessDate',
      ]);
    });

    it('counts a checked-in booking as active too', async () => {
      const date = nextDate();
      await booking(date, ReservationStatus.CHECKED_IN);

      expect(uniqueViolationTargets(await failureOf(booking(date)))).toEqual([
        'tableId',
        'businessDate',
      ]);
    });

    it('lets the table be booked again once a booking is cancelled, completed or a no show', async () => {
      const date = nextDate();
      await booking(date, ReservationStatus.CANCELLED);
      await booking(date, ReservationStatus.COMPLETED);
      await booking(date, ReservationStatus.NO_SHOW);

      await expect(booking(date)).resolves.toMatchObject({
        status: ReservationStatus.CONFIRMED,
      });
    });

    it('lets two racing bookings for one table and date commit only once', async () => {
      const date = nextDate();

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => booking(date)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('refuses a cancelled booking with no cancellation time', async () => {
      const date = nextDate();

      await expect(
        prisma.reservation.create({
          data: {
            number: await drawNumber(prisma, 'reservation'),
            tableId,
            name: 'Probe Guest',
            phone: '08031234567',
            businessDate: date,
            startMinutes: 720,
            party: 2,
            status: ReservationStatus.CANCELLED,
            source: ReservationSource.RECEPTION,
          },
        }),
      ).rejects.toThrow(/Reservation_cancelled_check/);
    });
  });

  describe('one open allocation per table', () => {
    const occupy = (forTable: string) =>
      prisma.tableSession.create({
        data: {
          tableId: forTable,
          status: TableSessionStatus.OCCUPIED,
          guest: 'Probe Guest',
          party: 2,
          openedById: staffId,
        },
      });

    /** A table of its own, so the tests never share an open session. */
    const freshTable = async () => {
      const { venueId } = await prisma.diningTable.findUniqueOrThrow({
        where: { id: tableId },
        select: { venueId: true },
      });

      return (
        await prisma.diningTable.create({
          data: {
            venueId,
            code: `P${randomUUID().slice(0, 6)}`,
            name: 'Probe',
            kind: TableKind.TWO,
            capacity: 2,
          },
        })
      ).id;
    };

    it('refuses a second open session on a table, as a clash on tableId', async () => {
      const table = await freshTable();
      await occupy(table);

      expect(uniqueViolationTargets(await failureOf(occupy(table)))).toEqual([
        'tableId',
      ]);
    });

    it('allows a new session once the last one has ended', async () => {
      const table = await freshTable();
      const first = await occupy(table);

      await prisma.tableSession.update({
        where: { id: first.id },
        data: { endedAt: new Date(), closedById: staffId },
      });

      await expect(occupy(table)).resolves.toMatchObject({ endedAt: null });
    });

    it('refuses a lock without a reason', async () => {
      const table = await freshTable();

      await expect(
        prisma.tableSession.create({
          data: {
            tableId: table,
            status: TableSessionStatus.LOCKED,
            openedById: staffId,
          },
        }),
      ).rejects.toThrow(/TableSession_shape_check/);
    });
  });

  describe('bills, lines and payments', () => {
    const openOrder = async () =>
      prisma.order.create({
        data: {
          number: await drawNumber(prisma, 'orderRestaurant'),
          department: Department.RESTAURANT,
          label: 'Probe',
          businessDate: isoDate('2031-01-01'),
          vatBps: 750,
          serviceBps: 0,
        },
      });

    it('refuses a settled bill with no settlement time', async () => {
      await expect(
        prisma.order.create({
          data: {
            number: await drawNumber(prisma, 'orderRestaurant'),
            department: Department.RESTAURANT,
            label: 'Probe',
            businessDate: isoDate('2031-01-01'),
            status: OrderStatus.SETTLED,
            vatBps: 750,
            serviceBps: 0,
          },
        }),
      ).rejects.toThrow(/Order_settled_check/);
    });

    it('refuses a line above 999', async () => {
      const order = await openOrder();

      await expect(
        prisma.orderLine.create({
          data: {
            orderId: order.id,
            menuItemId,
            name: 'Probe Dish',
            qty: 1000,
            unitPriceKobo: 100000,
            department: Department.RESTAURANT,
          },
        }),
      ).rejects.toThrow(/OrderLine_values_check/);
    });

    it('refuses a payment of nothing', async () => {
      const order = await openOrder();

      await expect(
        prisma.payment.create({
          data: {
            number: await drawNumber(prisma, 'payment'),
            orderId: order.id,
            method: 'CASH',
            amountKobo: 0,
            businessDate: isoDate('2031-01-01'),
          },
        }),
      ).rejects.toThrow(/Payment_amount_check/);
    });
  });

  describe('stock movements', () => {
    let stockItemId: string;

    beforeAll(async () => {
      stockItemId = (
        await prisma.stockItem.create({
          data: {
            name: `Probe Portion ${tag}`,
            kind: StockKind.KITCHEN,
            unit: 'portion',
            pack: 'tray',
            factor: 10,
            minimum: 5,
          },
        })
      ).id;
    });

    const movement = () =>
      prisma.stockMovement.create({
        data: {
          stockItemId,
          location: StockLocation.STORE,
          qty: 2,
          type: StockMovementType.STOCK_COUNT,
          ref: 'Probe',
          staffId,
        },
      });

    it('refuses a movement of zero', async () => {
      await expect(
        prisma.stockMovement.create({
          data: {
            stockItemId,
            location: StockLocation.STORE,
            qty: 0,
            type: StockMovementType.STOCK_COUNT,
            ref: 'Probe',
          },
        }),
      ).rejects.toThrow(/StockMovement_qty_check/);
    });

    it('refuses to change or delete a movement', async () => {
      const { id } = await movement();

      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "StockMovement" SET "qty" = 200 WHERE "id" = $1`,
          id,
        ),
      ).rejects.toThrow(/append-only: UPDATE/);
      await expect(
        prisma.stockMovement.deleteMany({ where: { id } }),
      ).rejects.toThrow(/append-only: DELETE/);

      const stored = await prisma.stockMovement.findUniqueOrThrow({
        where: { id },
      });
      expect(stored.qty).toBe(2);
    });

    it('refuses to truncate the table', async () => {
      await inRolledBack(async (tx) => {
        await expect(
          tx.$executeRawUnsafe(`TRUNCATE "StockMovement" CASCADE`),
        ).rejects.toThrow(/append-only: TRUNCATE/);
      });
    });

    it('is the trigger that refuses: with it dropped, the same update goes through', async () => {
      const { id } = await movement();

      await inRolledBack(async (tx) => {
        await tx.$executeRawUnsafe(
          `DROP TRIGGER "StockMovement_append_only_row" ON "StockMovement"`,
        );
        await expect(
          tx.$executeRawUnsafe(
            `UPDATE "StockMovement" SET "qty" = 200 WHERE "id" = $1`,
            id,
          ),
        ).resolves.toBe(1);
      });

      const stored = await prisma.stockMovement.findUniqueOrThrow({
        where: { id },
      });
      expect(stored.qty).toBe(2);
    });

    it('refuses a comparison rule of zero portions', async () => {
      await expect(
        prisma.kitchenMapping.create({
          data: { menuItemId, stockItemId, qty: 0 },
        }),
      ).rejects.toThrow(/KitchenMapping_qty_check/);
    });
  });
});
