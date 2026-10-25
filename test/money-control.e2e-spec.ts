import { ForbiddenException, INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { Prisma, StaffRole } from '../generated/cnc-client';
import {
  LAST_ACTIVE_OWNER_MESSAGE,
  LIMITED_DECISIONS,
  type LimitedDecision,
  MoneyControlService,
  dailyLimitMessage,
} from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp } from './create-test-app';
import { type StaffAccount, createStaffAccount } from './staff-fixtures';

/**
 * The money controls against Postgres (C3-4): the Daily Approval Limit's
 * ledger, its lock under two simultaneous approvals, its append-only
 * trigger, and the last-Owner rule. The rules' wording and the cases ported
 * from the staff app's `owner.test.cjs` are in the unit spec; this suite
 * proves what only the database can.
 *
 * Tests that change the settings or the Owners run inside a transaction
 * that is rolled back, so the shared test database keeps its settings and
 * its Owners. The accounts and ledger rows a test commits are run-unique and
 * never removed.
 */
describe('money controls (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let money: MoneyControlService;

  /** 30 September 2026, 23:30 in Jos. */
  const NOW = new Date('2026-09-30T22:30:00.000Z');
  /** The next morning, a new business date. */
  const NEXT = new Date('2026-10-01T10:00:00.000Z');

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    money = app.get(MoneyControlService, { strict: false });
    // The seeded settings row, with the column defaults, if no seed has run
    // on this database yet. Inserts nothing when it is there.
    await prisma.settings.createMany({ data: [{}], skipDuplicates: true });
  });

  afterAll(async () => {
    await app.close();
  });

  class Rollback extends Error {}

  /**
   * Run `work` in a transaction and roll it back whatever happens.
   *
   * READ COMMITTED by default, which the ledger tests need: a decision
   * waiting on the advisory lock must see the ledger row the first one
   * committed. The last-Owner tests pass REPEATABLE READ instead, so the
   * Owners they count are the ones their snapshot holds: under READ
   * COMMITTED an Owner account another suite committed in the meantime
   * counted as a second active Owner.
   */
  async function rolledBack(
    work: (tx: Prisma.TransactionClient) => Promise<void>,
    isolationLevel?: Prisma.TransactionIsolationLevel,
  ): Promise<void> {
    await expect(
      prisma.$transaction(
        async (tx) => {
          await work(tx);
          throw new Rollback();
        },
        isolationLevel ? { isolationLevel } : undefined,
      ),
    ).rejects.toBeInstanceOf(Rollback);
  }

  const staff = (role: StaffRole): Promise<StaffAccount> =>
    createStaffAccount(prisma, role, { emailPrefix: 'money' });

  /** One `bar-1` write-off in the demo tests: 6,500 naira. */
  const writeOff = (at = NOW): LimitedDecision => ({
    amountKobo: 650_000,
    what: LIMITED_DECISIONS.writeOff,
    count: true,
    action: 'waste.approve',
    ref: 'W-000001',
    at,
  });

  async function refusal(promise: Promise<unknown>): Promise<string> {
    const error: unknown = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ForbiddenException);

    return (error as ForbiddenException).message;
  }

  async function ledgerTotal(
    client: Pick<Prisma.TransactionClient, 'approvalLedger'>,
    staffId: string,
    businessDate: string,
  ): Promise<number> {
    const rows = await client.approvalLedger.findMany({
      where: { staffId, businessDate: new Date(`${businessDate}T00:00:00Z`) },
      select: { amountKobo: true },
    });

    return rows.reduce((sum, row) => sum + row.amountKobo, 0);
  }

  it('records a counted decision under its business date in Jos, and never the Owner', async () => {
    const manager = await staff(StaffRole.MANAGER);
    const owner = await staff(StaffRole.OWNER);

    await prisma.$transaction((tx) =>
      money.withinLimit(tx, manager, { ...writeOff(), ref: 'W-000042' }),
    );
    await prisma.$transaction((tx) => money.withinLimit(tx, owner, writeOff()));

    const rows = await prisma.approvalLedger.findMany({
      where: { staffId: { in: [manager.id, owner.id] } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      staffId: manager.id,
      amountKobo: 650_000,
      action: 'waste.approve',
      ref: 'W-000042',
    });
    // 23:30 on the 30th in Jos is 22:30 UTC: the 30th, not the 1st.
    expect(rows[0].businessDate.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  // owner.test.cjs: "the Daily Approval Limit caps one manager across
  // decisions, is on by default, and only the Owner changes it", with the
  // demo's numbers: ₦15,000 a day and ₦6,500 a write-off.
  it('caps one manager across decisions, separately from another manager and the Owner', async () => {
    const manager = await staff(StaffRole.MANAGER);
    const manager2 = await staff(StaffRole.MANAGER);
    const owner = await staff(StaffRole.OWNER);

    await rolledBack(async (tx) => {
      await tx.settings.update({
        where: { singleton: true },
        data: {
          approvalLimitKobo: 5_000_000,
          dailyLimitOn: true,
          dailyLimitKobo: 1_500_000,
        },
      });

      await money.withinLimit(tx, manager, writeOff());
      await money.withinLimit(tx, manager, writeOff());
      expect(await ledgerTotal(tx, manager.id, '2026-09-30')).toBe(1_300_000);

      expect(await refusal(money.withinLimit(tx, manager, writeOff()))).toBe(
        'This would take your approvals today to ₦19,500, above the Daily Approval Limit of ₦15,000. The Owner must approve it.',
      );
      expect(await ledgerTotal(tx, manager.id, '2026-09-30')).toBe(1_300_000);

      await money.withinLimit(tx, manager2, writeOff());
      await money.withinLimit(tx, owner, writeOff());
      expect(await ledgerTotal(tx, owner.id, '2026-09-30')).toBe(0);

      // Off: the decision passes and is still recorded (D36).
      await tx.settings.update({
        where: { singleton: true },
        data: { dailyLimitOn: false },
      });
      await money.withinLimit(tx, manager, writeOff());
      expect(await ledgerTotal(tx, manager.id, '2026-09-30')).toBe(1_950_000);

      // On again: the day's decisions already made count.
      await tx.settings.update({
        where: { singleton: true },
        data: { dailyLimitOn: true },
      });
      expect(await refusal(money.withinLimit(tx, manager, writeOff()))).toBe(
        dailyLimitMessage(2_600_000, 1_500_000),
      );
    });
  });

  // owner.test.cjs: "the daily total starts fresh each business day".
  it('starts the total fresh on the next business date', async () => {
    const manager = await staff(StaffRole.MANAGER);

    await rolledBack(async (tx) => {
      await tx.settings.update({
        where: { singleton: true },
        data: { dailyLimitOn: true, dailyLimitKobo: 1_000_000 },
      });

      await money.withinLimit(tx, manager, writeOff(NOW));
      expect(await refusal(money.withinLimit(tx, manager, writeOff(NOW)))).toBe(
        dailyLimitMessage(1_300_000, 1_000_000),
      );
      await money.withinLimit(tx, manager, writeOff(NEXT));

      expect(await ledgerTotal(tx, manager.id, '2026-10-01')).toBe(650_000);
    });
  });

  it('applies a lowered per-decision limit at once', async () => {
    const manager = await staff(StaffRole.MANAGER);

    await rolledBack(async (tx) => {
      await tx.settings.update({
        where: { singleton: true },
        data: { approvalLimitKobo: 100_000 },
      });

      expect(
        await refusal(
          money.withinLimit(tx, manager, {
            amountKobo: 200_000,
            what: LIMITED_DECISIONS.discount,
            count: true,
            action: 'order.discount',
            at: NOW,
          }),
        ),
      ).toBe(
        'This discount is above the Owner Approval Limit of ₦1,000. The Owner must approve it.',
      );
    });
  });

  it('lets exactly one of two simultaneous approvals take the last of the day', async () => {
    const settings = await prisma.settings.findUniqueOrThrow({
      where: { singleton: true },
    });
    // The race needs the limit on, and room for one decision at the limit.
    expect(settings.dailyLimitOn).toBe(true);
    expect(settings.dailyLimitKobo).toBeGreaterThanOrEqual(
      settings.approvalLimitKobo,
    );

    const limit = settings.approvalLimitKobo;
    const daily = settings.dailyLimitKobo;
    const manager = await staff(StaffRole.MANAGER);
    const RACE = new Date('2026-08-15T10:00:00.000Z');

    // The day so far: exactly one decision at the limit short of full.
    if (daily > limit) {
      await prisma.approvalLedger.create({
        data: {
          businessDate: new Date('2026-08-15T00:00:00.000Z'),
          staffId: manager.id,
          amountKobo: daily - limit,
          action: 'waste.approve',
          ref: 'W-PREVIOUS',
        },
      });
    }

    const approve = (ref: string) =>
      prisma.$transaction(async (tx) => {
        await money.withinLimit(tx, manager, {
          amountKobo: limit,
          what: LIMITED_DECISIONS.purchase,
          count: true,
          action: 'purchase.approve',
          ref,
          at: RACE,
        });
        // Hold the transaction open, so both are inside the check at once.
        await tx.$executeRaw`SELECT pg_sleep(0.3)`;
      });

    const results = await Promise.allSettled([
      approve('PR-RACE-1'),
      approve('PR-RACE-2'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ForbiddenException);
    expect((rejected[0].reason as ForbiddenException).message).toBe(
      dailyLimitMessage(daily + limit, daily),
    );

    expect(await ledgerTotal(prisma, manager.id, '2026-08-15')).toBe(daily);
  });

  describe('the ledger is append-only', () => {
    let rowId: string;

    beforeAll(async () => {
      const manager = await staff(StaffRole.MANAGER);
      await prisma.$transaction((tx) =>
        money.withinLimit(tx, manager, writeOff()),
      );
      const row = await prisma.approvalLedger.findFirstOrThrow({
        where: { staffId: manager.id },
      });
      rowId = row.id;
    });

    it.each([
      [
        'UPDATE',
        (id: string) =>
          prisma.$executeRaw`UPDATE "ApprovalLedger" SET "amountKobo" = 1 WHERE "id" = ${id}`,
      ],
      [
        'DELETE',
        (id: string) =>
          prisma.$executeRaw`DELETE FROM "ApprovalLedger" WHERE "id" = ${id}`,
      ],
      // From C8-0 the ledger is referenced (a release names its row, a card
      // refund the row that counted it), so a plain TRUNCATE stops at the
      // foreign keys first; CASCADE gets past them and meets the trigger,
      // which fires before anything is emptied.
      ['TRUNCATE', () => prisma.$executeRaw`TRUNCATE "ApprovalLedger" CASCADE`],
    ])('refuses %s', async (operation, run) => {
      await expect(run(rowId)).rejects.toThrow(
        `ApprovalLedger is append-only: ${operation} is not allowed`,
      );
      await expect(
        prisma.approvalLedger.findUnique({ where: { id: rowId } }),
      ).resolves.toMatchObject({ amountKobo: 650_000 });
    });

    it('refuses a row that counts nothing', async () => {
      const manager = await staff(StaffRole.MANAGER);

      await expect(
        prisma.approvalLedger.create({
          data: {
            businessDate: new Date('2026-09-30T00:00:00.000Z'),
            staffId: manager.id,
            amountKobo: 0,
            action: 'waste.approve',
          },
        }),
      ).rejects.toThrow(/ApprovalLedger_amount_check/);
    });
  });

  describe('release rows (C8-0)', () => {
    const DAY = new Date('2026-09-30T00:00:00.000Z');

    async function counted(): Promise<{ id: string; staffId: string }> {
      const manager = await staff(StaffRole.MANAGER);
      const row = await prisma.$transaction((tx) =>
        money.withinLimit(tx, manager, { ...writeOff(), ref: 'CNCR-REL-1' }),
      );

      return { id: row!.id, staffId: manager.id };
    }

    it('lets only a release row be negative', async () => {
      const manager = await staff(StaffRole.MANAGER);

      await expect(
        prisma.approvalLedger.create({
          data: {
            businessDate: DAY,
            staffId: manager.id,
            amountKobo: -650_000,
            action: 'online.refundRelease',
          },
        }),
      ).rejects.toThrow(/ApprovalLedger_amount_check/);
    });

    it('releases a row once, on its own day and person, never above it', async () => {
      const row = await counted();
      const release = (over: Record<string, unknown>) =>
        prisma.approvalLedger.create({
          data: {
            businessDate: DAY,
            staffId: row.staffId,
            amountKobo: -650_000,
            action: 'online.refundRelease',
            ref: 'CNCR-REL-1',
            releasesId: row.id,
            ...over,
          },
        });
      const other = await staff(StaffRole.MANAGER);

      for (const wrong of [
        { amountKobo: -650_001 },
        { businessDate: new Date('2026-10-01T00:00:00.000Z') },
        { staffId: other.id },
        { ref: 'CNCR-OTHER' },
      ]) {
        await expect(release(wrong)).rejects.toThrow(
          /does not match the row it releases/,
        );
      }

      const first = await release({});

      await expect(release({ amountKobo: -1 })).rejects.toThrow();
      // A release is never released, so it cannot be cancelled out.
      await expect(
        prisma.approvalLedger.create({
          data: {
            businessDate: DAY,
            staffId: row.staffId,
            amountKobo: -1,
            action: 'online.refundRelease',
            ref: 'CNCR-REL-1',
            releasesId: first.id,
          },
        }),
      ).rejects.toThrow(/does not match the row it releases/);
      expect(await ledgerTotal(prisma, row.staffId, '2026-09-30')).toBe(0);
    });

    it('is reflected in the standing', async () => {
      const row = await counted();

      await prisma.$transaction((tx) =>
        money.releaseCounted(tx, row.id, 400_000),
      );

      expect(
        await money.standing(
          prisma,
          { id: row.staffId, role: StaffRole.MANAGER },
          NOW,
        ),
      ).toMatchObject({ approvedTodayKobo: 250_000 });
    });
  });

  describe('the last active Owner', () => {
    /**
     * Inside the rolled-back transaction, every other Owner is set inactive
     * first, so the test decides how many active Owners exist.
     */
    async function onlyTheseOwners(
      tx: Prisma.TransactionClient,
      ...owners: StaffAccount[]
    ): Promise<void> {
      await tx.staff.updateMany({
        where: {
          role: StaffRole.OWNER,
          id: { notIn: owners.map((owner) => owner.id) },
        },
        data: { isActive: false },
      });
    }

    it('refuses demoting or deactivating the only active Owner', async () => {
      const owner = await staff(StaffRole.OWNER);

      await rolledBack(async (tx) => {
        await onlyTheseOwners(tx, owner);

        for (const change of [
          { newRole: StaffRole.MANAGER, newIsActive: true },
          { newRole: StaffRole.OWNER, newIsActive: false },
        ]) {
          expect(
            await refusal(
              money.keepsAnActiveOwner(tx, {
                staffId: owner.id,
                currentRole: StaffRole.OWNER,
                ...change,
              }),
            ),
          ).toBe(LAST_ACTIVE_OWNER_MESSAGE);
        }
      }, Prisma.TransactionIsolationLevel.RepeatableRead);
    });

    it('lets an Owner step down while another is active, and counts only active Owners', async () => {
      const owner = await staff(StaffRole.OWNER);
      const second = await staff(StaffRole.OWNER);

      await rolledBack(async (tx) => {
        await onlyTheseOwners(tx, owner, second);

        await money.keepsAnActiveOwner(tx, {
          staffId: owner.id,
          currentRole: StaffRole.OWNER,
          newRole: StaffRole.MANAGER,
          newIsActive: true,
        });

        // The second Owner deactivated: the first is alone again.
        await tx.staff.update({
          where: { id: second.id },
          data: { isActive: false },
        });
        expect(
          await refusal(
            money.keepsAnActiveOwner(tx, {
              staffId: owner.id,
              currentRole: StaffRole.OWNER,
              newRole: StaffRole.MANAGER,
              newIsActive: true,
            }),
          ),
        ).toBe(LAST_ACTIVE_OWNER_MESSAGE);
      }, Prisma.TransactionIsolationLevel.RepeatableRead);
    });
  });
});
