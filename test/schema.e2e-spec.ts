import { randomInt, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { Prisma } from '../generated/cnc-client';
import { canonicalNigerianPhone } from '../src/common/nigerian-phone';
import { CncConfigService } from '../src/config/cnc.config';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber, SEQUENCES } from '../src/prisma/sequences';
import { uniqueViolationTargets } from '../src/prisma/unique-violation';
import { createTestApp } from './create-test-app';
import { lockSharedRows } from './shared-rows-lock';

/**
 * What the C3 core migration adds by hand, checked against Postgres: the
 * append-only audit trigger, the human-number sequences, the CHECKs and the
 * case-insensitive stock item name. Prisma's schema says none of this, so a
 * migration that lost one would pass every other test.
 *
 * Rows are run-unique and never removed. Anything that changes the schema
 * (dropping the trigger to watch the guard go) happens inside a transaction
 * that is rolled back, with a lock timeout so it never stalls a suite beside
 * it.
 */
describe('C3 core schema (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
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

  describe('the audit log', () => {
    async function systemEntry(): Promise<string> {
      const { id } = await prisma.auditLog.create({
        data: {
          actorKind: 'SYSTEM',
          actorName: 'System',
          action: 'schema.probe',
          module: 'test',
          ref: `probe-${randomUUID()}`,
        },
        select: { id: true },
      });

      return id;
    }

    it('accepts a new entry', async () => {
      const id = await systemEntry();

      await expect(
        prisma.auditLog.findUnique({ where: { id } }),
      ).resolves.not.toBeNull();
    });

    it('refuses to change an entry', async () => {
      const id = await systemEntry();

      await expect(
        prisma.auditLog.update({ where: { id }, data: { reason: 'edited' } }),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE "AuditLog" SET "actorName" = 'Someone else' WHERE "id" = $1`,
          id,
        ),
      ).rejects.toThrow(/append-only: UPDATE/);

      const stored = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
      expect([stored.reason, stored.actorName]).toEqual([null, 'System']);
    });

    it('refuses to delete an entry', async () => {
      const id = await systemEntry();

      await expect(prisma.auditLog.delete({ where: { id } })).rejects.toThrow(
        /append-only/,
      );
      await expect(
        prisma.auditLog.deleteMany({ where: { id } }),
      ).rejects.toThrow(/append-only: DELETE/);

      await expect(
        prisma.auditLog.findUnique({ where: { id } }),
      ).resolves.not.toBeNull();
    });

    it('refuses to truncate the table', async () => {
      await inRolledBack(async (tx) => {
        await expect(
          tx.$executeRawUnsafe(`TRUNCATE "AuditLog"`),
        ).rejects.toThrow(/append-only: TRUNCATE/);
      });
    });

    it('is the trigger that refuses: with it dropped, the same update goes through', async () => {
      // Verifying the guard by watching it go (docs/conventions.md,
      // Verification). The drop and the update are rolled back together.
      const id = await systemEntry();

      await inRolledBack(async (tx) => {
        await tx.$executeRawUnsafe(
          `DROP TRIGGER "AuditLog_append_only_row" ON "AuditLog"`,
        );
        await expect(
          tx.$executeRawUnsafe(
            `UPDATE "AuditLog" SET "reason" = 'edited' WHERE "id" = $1`,
            id,
          ),
        ).resolves.toBe(1);
      });

      const stored = await prisma.auditLog.findUniqueOrThrow({ where: { id } });
      expect(stored.reason).toBeNull();
      await expect(
        prisma.auditLog.update({ where: { id }, data: { reason: 'edited' } }),
      ).rejects.toThrow(/append-only/);
    });

    it('refuses an entry whose actor does not match its kind', async () => {
      await expect(
        prisma.auditLog.create({
          data: {
            actorKind: 'STAFF',
            actorName: 'Nobody',
            action: 'schema.probe',
            module: 'test',
          },
        }),
      ).rejects.toThrow(/AuditLog_actor_check/);
    });
  });

  describe('sequences', () => {
    it.each(Object.keys(SEQUENCES) as (keyof typeof SEQUENCES)[])(
      'draws a %s number in its own format',
      async (name) => {
        const { prefix, minDigits } = SEQUENCES[name];
        const code = await drawNumber(prisma, name);

        expect(code.startsWith(prefix)).toBe(true);
        expect(code.slice(prefix.length)).toMatch(
          new RegExp(`^\\d{${minDigits},}$`),
        );
      },
    );

    it('hands concurrent callers different numbers', async () => {
      const codes = await Promise.all(
        Array.from({ length: 20 }, () => drawNumber(prisma, 'task')),
      );

      expect(new Set(codes).size).toBe(codes.length);
    });
  });

  describe('one row only', () => {
    it.each(['Settings', 'Business'])(
      'refuses a %s row that is not the singleton',
      async (table) => {
        const columns =
          table === 'Settings'
            ? `"id", "updatedAt", "singleton"`
            : `"id", "updatedAt", "singleton", "name", "addressLine", "phone", "email", "registration"`;
        const values =
          table === 'Settings'
            ? `$1, now() AT TIME ZONE 'UTC', false`
            : `$1, now() AT TIME ZONE 'UTC', false, 'x', 'x', '08022188797', 'x@example.com', 'x'`;

        await expect(
          prisma.$executeRawUnsafe(
            `INSERT INTO "${table}" (${columns}) VALUES (${values})`,
            randomUUID(),
          ),
        ).rejects.toThrow(new RegExp(`${table}_singleton_check`));
      },
    );
  });

  describe('opening hours', () => {
    // The settings suite commits an edited week through
    // `PUT /staff/opening-hours` (deleting and recreating the days) and puts
    // the original back in its `afterAll`, under the shared-rows lock. Held
    // here too, so these two tests never read or update a day in the middle
    // of that, which they did in a parallel run.
    let unlockSharedRows: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      unlockSharedRows = await lockSharedRows(
        app.get(CncConfigService).databaseUrl,
      );
    });

    afterAll(async () => {
      await unlockSharedRows?.();
    });

    it('starts with every day open 08:00 to midnight', async () => {
      const days = await prisma.openingHoursDay.findMany({
        orderBy: { dayOfWeek: 'asc' },
      });

      expect(days.map((d) => d.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      // Every suite that edits the week restores it before it releases the
      // lock, so the migration's values stand while this block holds it.
      for (const day of days) {
        expect(day).toMatchObject({
          isClosed: false,
          opensAtMinutes: 480,
          closesAtMinutes: 1440,
        });
      }
    });

    it('refuses a day that closes before it opens', async () => {
      await expect(
        prisma.openingHoursDay.update({
          where: { dayOfWeek: 0 },
          data: { opensAtMinutes: 900, closesAtMinutes: 600 },
        }),
      ).rejects.toThrow(/OpeningHoursDay_shape_check/);
    });
  });

  describe('people', () => {
    function phone(): string {
      return `080${String(randomInt(0, 100_000_000)).padStart(8, '0')}`;
    }

    async function customer(data: { email?: string; phone?: string }) {
      return prisma.customer.create({
        data: {
          memberNo: await drawNumber(prisma, 'customer'),
          name: 'Probe Customer',
          ...data,
        },
      });
    }

    it('stores a customer phone in the canonical form', async () => {
      const stored = await customer({
        phone: canonicalNigerianPhone(`+234${phone().slice(1)}`),
      });

      expect(stored.phone).toMatch(/^0[789][01]\d{8}$/);
      expect(stored.memberNo).toMatch(/^CNC-\d{6,}$/);
    });

    it('refuses a customer phone in any other spelling', async () => {
      await expect(
        customer({ phone: `+234${phone().slice(1)}` }),
      ).rejects.toThrow(/Customer_phone_format_check/);
    });

    it('refuses an email that is not lower case', async () => {
      await expect(
        customer({ email: `Probe-${randomUUID()}@Example.com` }),
      ).rejects.toThrow(/Customer_email_lower_check/);

      await expect(
        prisma.staff.create({
          data: {
            staffNo: await drawNumber(prisma, 'staff'),
            name: 'Probe Staff',
            email: `Probe-${randomUUID()}@Example.com`,
            role: 'CASHIER',
            passwordHash: 'not-a-real-hash',
            qrToken: randomUUID(),
            joinedOn: new Date('2026-10-20T00:00:00.000Z'),
          },
        }),
      ).rejects.toThrow(/Staff_email_lower_check/);
    });
  });

  describe('stock items', () => {
    const item = (name: string) => ({
      name,
      kind: 'KITCHEN' as const,
      unit: 'portion',
      pack: 'pack',
      factor: 1,
      minimum: 0,
    });

    it('refuses a name that differs only in case, as a clash on name', async () => {
      const name = `Probe Rice ${randomUUID()}`;
      await prisma.stockItem.create({ data: item(name) });

      const clash = await prisma.stockItem
        .create({ data: item(name.toLowerCase()) })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(clash).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(uniqueViolationTargets(clash)).toEqual(['name']);
    });

    it('refuses a Bar item with no menu item', async () => {
      await expect(
        prisma.stockItem.create({
          data: { ...item(`Probe Bar ${randomUUID()}`), kind: 'BAR' },
        }),
      ).rejects.toThrow(/StockItem_pairing_check/);
    });

    it('refuses a conversion of zero', async () => {
      await expect(
        prisma.stockItem.create({
          data: { ...item(`Probe ${randomUUID()}`), factor: 0 },
        }),
      ).rejects.toThrow(/StockItem_values_check/);
    });
  });

  describe('web pushes (C10)', () => {
    const push = (owners: { customerId?: string; staffId?: string }) => {
      const key = `probe:${randomUUID()}`;

      return prisma.pushMessage.create({
        data: {
          ...owners,
          event: 'task.assigned',
          topic: key,
          dedupeKey: key,
          title: 'New task assigned to you',
          body: 'Open Tasks to see it.',
          tag: key,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
    };

    it('holds exactly one recipient on a push: a customer or a staff member', async () => {
      const customer = await prisma.customer.create({
        data: {
          memberNo: await drawNumber(prisma, 'customer'),
          name: 'Probe Push',
        },
      });
      const staff = await prisma.staff.create({
        data: {
          staffNo: await drawNumber(prisma, 'staff'),
          name: 'Probe Push',
          email: `probe-push-${randomUUID()}@cnc.test`,
          role: 'KITCHEN',
          passwordHash: 'not-a-real-hash',
          qrToken: randomUUID(),
          joinedOn: new Date('2026-10-20T00:00:00.000Z'),
        },
      });

      await expect(push({ customerId: customer.id })).resolves.toBeTruthy();
      await expect(push({ staffId: staff.id })).resolves.toBeTruthy();
      await expect(
        push({ customerId: customer.id, staffId: staff.id }),
      ).rejects.toThrow(/PushMessage_one_recipient_check/);
      await expect(push({})).rejects.toThrow(/PushMessage_one_recipient_check/);
    });
  });
});
