import { ForbiddenException } from '@nestjs/common';
import { type Prisma, StaffRole } from '../../generated/cnc-client';
import {
  LAST_ACTIVE_OWNER_MESSAGE,
  LIMITED_DECISIONS,
  MoneyControlService,
  OWN_RECORD_KINDS,
  OWNER_ONLY_ACTIONS,
  OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE,
  OWNER_ONLY_PRICE_MESSAGE,
  approvalLimitMessage,
  dailyLimitMessage,
  ownRecordMessage,
} from './money-control.service';

/**
 * The Owner's money rules, ported from the staff app's
 * `staff/tests/owner.test.cjs` where a test applies to the rule itself
 * rather than to a command that arrives in a later card. The messages are
 * asserted as whole strings: the screens show them as they stand (A7).
 *
 * The transaction is a fake that keeps the ledger in memory and records the
 * order of the calls; `test/money-control.e2e-spec.ts` runs the same rules
 * against Postgres, with the lock under real concurrency.
 */

const owner = { id: 'owner-1', role: StaffRole.OWNER };
const manager = { id: 'manager-1', role: StaffRole.MANAGER };
const manager2 = { id: 'manager-2', role: StaffRole.MANAGER };

/** 30 September 2026, 23:30 in Jos: the demo tests' `NOW`. */
const NOW = new Date('2026-09-30T22:30:00.000Z');
/** The next morning, a new business date. */
const NEXT = new Date('2026-10-01T10:00:00.000Z');

interface LedgerRow {
  staffId: string;
  businessDate: string;
  amountKobo: number;
  action: string;
  ref: string | null;
}

interface FakeSettings {
  approvalLimitKobo: number;
  dailyLimitOn: boolean;
  dailyLimitKobo: number;
}

/** The demo's defaults: ₦50,000 per decision, ₦150,000 a day, on. */
const DEFAULTS: FakeSettings = {
  approvalLimitKobo: 5_000_000,
  dailyLimitOn: true,
  dailyLimitKobo: 15_000_000,
};

function fakeTx(options: { activeOtherOwners?: number } = {}) {
  const settings: FakeSettings = { ...DEFAULTS };
  const ledger: LedgerRow[] = [];
  const calls: string[] = [];

  const tx = {
    settings: {
      findUnique: jest.fn(() => {
        calls.push('settings');
        return Promise.resolve({ ...settings });
      }),
    },
    $executeRaw: jest.fn(() => {
      calls.push('lock');
      return Promise.resolve(1);
    }),
    $queryRaw: jest.fn((_sql: TemplateStringsArray, ...values: unknown[]) => {
      calls.push('sum');
      const [staffId, isoDate] = values as [string, string];
      const total = ledger
        .filter(
          (row) => row.staffId === staffId && row.businessDate === isoDate,
        )
        .reduce((sum, row) => sum + row.amountKobo, 0);

      return Promise.resolve([{ total: BigInt(total) }]);
    }),
    approvalLedger: {
      create: jest.fn(
        ({
          data,
        }: {
          data: Omit<LedgerRow, 'businessDate'> & { businessDate: Date };
        }) => {
          calls.push('insert');
          ledger.push({
            ...data,
            businessDate: data.businessDate.toISOString().slice(0, 10),
          });
          return Promise.resolve({});
        },
      ),
    },
    staff: {
      count: jest.fn(() => {
        calls.push('count');
        return Promise.resolve(options.activeOtherOwners ?? 0);
      }),
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    settings,
    ledger,
    calls,
    approvedBy: (staffId: string) =>
      ledger
        .filter((row) => row.staffId === staffId)
        .reduce((sum, row) => sum + row.amountKobo, 0),
  };
}

async function refusal(promise: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    return (error as ForbiddenException).message;
  }

  throw new Error('Expected a 403 refusal, and the call succeeded.');
}

describe('MoneyControlService', () => {
  const money = new MoneyControlService();

  describe('ownerOnly', () => {
    it('only the Owner reverses a paid bill', async () => {
      expect(
        await refusal(() =>
          money.ownerOnly(manager, OWNER_ONLY_ACTIONS.reverseBill),
        ),
      ).toBe('Only the Owner can reverse a paid bill.');
      expect(() =>
        money.ownerOnly(owner, OWNER_ONLY_ACTIONS.reverseBill),
      ).not.toThrow();
    });

    it('only the Owner corrects a stock balance', async () => {
      expect(
        await refusal(() =>
          money.ownerOnly(manager, OWNER_ONLY_ACTIONS.correctStockBalance),
        ),
      ).toBe('Only the Owner can correct a stock balance.');
      expect(() =>
        money.ownerOnly(owner, OWNER_ONLY_ACTIONS.correctStockBalance),
      ).not.toThrow();
    });

    it('carries the other Owner-only sentences as they stand', async () => {
      expect(
        await refusal(() =>
          money.requireOwner(manager, OWNER_ONLY_PRICE_MESSAGE),
        ),
      ).toBe('Only the Owner can change a price.');
      expect(() =>
        money.requireOwner(owner, OWNER_ONLY_PRICE_MESSAGE),
      ).not.toThrow();
    });
  });

  describe('Manager and Owner accounts', () => {
    // owner.test.cjs: "only the Owner creates or changes Manager and Owner
    // accounts, and one Owner always remains".
    it('lets a manager hire a Cashier but not a Manager or an Owner', async () => {
      expect(() =>
        money.mayChangeAccount(manager, { newRole: StaffRole.CASHIER }),
      ).not.toThrow();

      for (const newRole of [StaffRole.MANAGER, StaffRole.OWNER]) {
        expect(
          await refusal(() => money.mayChangeAccount(manager, { newRole })),
        ).toBe(OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE);
      }
    });

    it('refuses a manager promoting staff, or changing a Manager or the Owner', async () => {
      const cases = [
        { currentRole: StaffRole.WAITER, newRole: StaffRole.MANAGER },
        { currentRole: StaffRole.MANAGER, newRole: StaffRole.CASHIER },
        { currentRole: StaffRole.OWNER, newRole: StaffRole.OWNER },
        { currentRole: StaffRole.MANAGER },
      ];

      for (const account of cases) {
        expect(
          await refusal(() => money.mayChangeAccount(manager, account)),
        ).toBe(
          'Only the Owner can create or change Manager and Owner accounts.',
        );
      }
    });

    it('lets the Owner create and change any account', () => {
      expect(() =>
        money.mayChangeAccount(owner, { newRole: StaffRole.MANAGER }),
      ).not.toThrow();
      expect(() =>
        money.mayChangeAccount(owner, {
          currentRole: StaffRole.MANAGER,
          newRole: StaffRole.CASHIER,
        }),
      ).not.toThrow();
    });

    it('refuses demoting or deactivating the only active Owner', async () => {
      for (const change of [
        { newRole: StaffRole.MANAGER, newIsActive: true },
        { newRole: StaffRole.OWNER, newIsActive: false },
      ]) {
        const { tx } = fakeTx({ activeOtherOwners: 0 });

        expect(
          await refusal(
            money.keepsAnActiveOwner(tx, {
              staffId: owner.id,
              currentRole: StaffRole.OWNER,
              ...change,
            }),
          ),
        ).toBe('CNC needs at least one active Owner.');
      }

      expect(LAST_ACTIVE_OWNER_MESSAGE).toBe(
        'CNC needs at least one active Owner.',
      );
    });

    it('lets an Owner step down while another active Owner exists', async () => {
      const { tx } = fakeTx({ activeOtherOwners: 1 });

      await expect(
        money.keepsAnActiveOwner(tx, {
          staffId: owner.id,
          currentRole: StaffRole.OWNER,
          newRole: StaffRole.MANAGER,
          newIsActive: true,
        }),
      ).resolves.toBeUndefined();
    });

    it('takes the owners lock before it counts, and only for an Owner change', async () => {
      const demoting = fakeTx({ activeOtherOwners: 1 });
      await money.keepsAnActiveOwner(demoting.tx, {
        staffId: owner.id,
        currentRole: StaffRole.OWNER,
        newRole: StaffRole.CASHIER,
        newIsActive: true,
      });
      expect(demoting.calls).toEqual(['lock', 'count']);

      const untouched = fakeTx();
      await money.keepsAnActiveOwner(untouched.tx, {
        staffId: manager.id,
        currentRole: StaffRole.MANAGER,
        newRole: StaffRole.CASHIER,
        newIsActive: false,
      });
      await money.keepsAnActiveOwner(untouched.tx, {
        staffId: owner.id,
        currentRole: StaffRole.OWNER,
        newRole: StaffRole.OWNER,
        newIsActive: true,
      });
      expect(untouched.calls).toEqual([]);
    });
  });

  describe('notOwn', () => {
    it('stops a manager approving a record they created, in each kind', async () => {
      for (const what of Object.values(OWN_RECORD_KINDS)) {
        expect(
          await refusal(() => money.notOwn(manager, manager.id, what)),
        ).toBe(
          `You cannot approve a ${what} you created. The Owner or another manager must approve it.`,
        );
      }
      expect(ownRecordMessage(OWN_RECORD_KINDS.wasteEntry)).toBe(
        'You cannot approve a waste entry you created. The Owner or another manager must approve it.',
      );
    });

    it('lets another manager, or the Owner on their own record, approve', () => {
      expect(() =>
        money.notOwn(manager2, manager.id, OWN_RECORD_KINDS.purchase),
      ).not.toThrow();
      expect(() =>
        money.notOwn(owner, owner.id, OWN_RECORD_KINDS.purchase),
      ).not.toThrow();
    });

    it('passes a record with no creator, as the demo does', () => {
      expect(() =>
        money.notOwn(manager, null, OWN_RECORD_KINDS.stockRequest),
      ).not.toThrow();
      expect(() =>
        money.notOwn(manager, undefined, OWN_RECORD_KINDS.stockRequest),
      ).not.toThrow();
    });
  });

  describe('the Owner Approval Limit', () => {
    // owner.test.cjs: "discounts above the limit need the Owner; a lowered
    // limit applies at once".
    it('allows a decision within the limit and refuses one above it', async () => {
      const { tx } = fakeTx();

      await money.withinLimit(tx, manager, {
        amountKobo: 4_000_000,
        what: LIMITED_DECISIONS.discount,
        count: true,
        action: 'order.discount',
        at: NOW,
      });

      expect(
        await refusal(
          money.withinLimit(tx, manager, {
            amountKobo: 5_000_100,
            what: LIMITED_DECISIONS.discount,
            count: true,
            action: 'order.discount',
            at: NOW,
          }),
        ),
      ).toBe(
        'This discount is above the Owner Approval Limit of ₦50,000. The Owner must approve it.',
      );
    });

    it('allows the limit itself', async () => {
      const { tx } = fakeTx();

      await expect(
        money.withinLimit(tx, manager, {
          amountKobo: 5_000_000,
          what: LIMITED_DECISIONS.purchase,
          action: 'purchase.edit',
        }),
      ).resolves.toBeUndefined();
    });

    it('exempts the Owner at any amount, and never records the Owner', async () => {
      const { tx, ledger, calls } = fakeTx();

      await money.withinLimit(tx, owner, {
        amountKobo: 5_000_100,
        what: LIMITED_DECISIONS.discount,
        count: true,
        action: 'order.discount',
        at: NOW,
      });

      expect(ledger).toEqual([]);
      expect(calls).toEqual([]);
    });

    it('applies a lowered limit at once', async () => {
      const { tx, settings } = fakeTx();
      settings.approvalLimitKobo = 100_000;

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
      ).toBe(approvalLimitMessage(LIMITED_DECISIONS.discount, 100_000));
      expect(approvalLimitMessage(LIMITED_DECISIONS.discount, 100_000)).toBe(
        'This discount is above the Owner Approval Limit of ₦1,000. The Owner must approve it.',
      );
    });

    // owner.test.cjs: "online payment corrections above the limit need the
    // Owner". A refund is negative and is judged by its size.
    it('judges a refund by its size', async () => {
      const { tx, settings, ledger } = fakeTx();
      settings.approvalLimitKobo = 1;

      expect(
        await refusal(
          money.withinLimit(tx, manager, {
            amountKobo: -650_000,
            what: LIMITED_DECISIONS.paymentCorrection,
            count: true,
            action: 'online.balance',
            at: NOW,
          }),
        ),
      ).toBe(
        'This payment correction is above the Owner Approval Limit of ₦0.01. The Owner must approve it.',
      );

      settings.approvalLimitKobo = 5_000_000;
      await money.withinLimit(tx, manager, {
        amountKobo: -650_000,
        what: LIMITED_DECISIONS.onlineChange,
        count: true,
        action: 'online.cancel',
        ref: 'WEB-000012',
        at: NOW,
      });
      expect(ledger).toEqual([
        {
          staffId: manager.id,
          businessDate: '2026-09-30',
          amountKobo: 650_000,
          action: 'online.cancel',
          ref: 'WEB-000012',
        },
      ]);
    });

    it('records nothing for a decision that does not count, or counts nothing', async () => {
      const { tx, ledger, calls } = fakeTx();

      await money.withinLimit(tx, manager, {
        amountKobo: 1_000_000,
        what: LIMITED_DECISIONS.writeOff,
        action: 'waste.edit',
        at: NOW,
      });
      await money.withinLimit(tx, manager, {
        amountKobo: 1_000_000,
        countedKobo: 0,
        what: LIMITED_DECISIONS.discount,
        count: true,
        action: 'order.discount',
        at: NOW,
      });

      expect(ledger).toEqual([]);
      expect(calls).toEqual(['settings', 'settings']);
    });
  });

  describe('the Daily Approval Limit', () => {
    /** One `bar-1` write-off in the demo tests: 6,500 naira. */
    const writeOff = (at = NOW) => ({
      amountKobo: 650_000,
      what: LIMITED_DECISIONS.writeOff,
      count: true,
      action: 'waste.approve',
      ref: 'W-000001',
      at,
    });

    // owner.test.cjs: "the Daily Approval Limit caps one manager across
    // decisions, is on by default, and only the Owner changes it".
    it('caps one manager across decisions; another manager and the Owner are not affected', async () => {
      const { tx, settings, approvedBy } = fakeTx();
      settings.dailyLimitKobo = 1_500_000;

      await money.withinLimit(tx, manager, writeOff());
      await money.withinLimit(tx, manager, writeOff());
      expect(approvedBy(manager.id)).toBe(1_300_000);

      expect(await refusal(money.withinLimit(tx, manager, writeOff()))).toBe(
        'This would take your approvals today to ₦19,500, above the Daily Approval Limit of ₦15,000. The Owner must approve it.',
      );
      expect(approvedBy(manager.id)).toBe(1_300_000);

      await money.withinLimit(tx, manager2, writeOff());
      expect(approvedBy(manager2.id)).toBe(650_000);

      await money.withinLimit(tx, owner, writeOff());
      expect(approvedBy(owner.id)).toBe(0);
    });

    it('counts different kinds of decision toward one total', async () => {
      const { tx, settings } = fakeTx();
      settings.dailyLimitKobo = 1_000_000;

      await money.withinLimit(tx, manager, {
        amountKobo: 600_000,
        what: LIMITED_DECISIONS.purchase,
        count: true,
        action: 'purchase.approve',
        at: NOW,
      });

      expect(
        await refusal(
          money.withinLimit(tx, manager, {
            amountKobo: 500_000,
            what: LIMITED_DECISIONS.discount,
            count: true,
            action: 'order.discount',
            at: NOW,
          }),
        ),
      ).toBe(dailyLimitMessage(1_100_000, 1_000_000));
    });

    it('counts only a discount’s increase toward the day', async () => {
      const { tx, approvedBy } = fakeTx();

      await money.withinLimit(tx, manager, {
        amountKobo: 3_000_000,
        countedKobo: 1_000_000,
        what: LIMITED_DECISIONS.discount,
        count: true,
        action: 'order.discount',
        at: NOW,
      });

      expect(approvedBy(manager.id)).toBe(1_000_000);
    });

    it('still records decisions while it is off, so switching it on counts them', async () => {
      const { tx, settings, approvedBy } = fakeTx();
      settings.dailyLimitKobo = 1_300_000;
      settings.dailyLimitOn = false;

      await money.withinLimit(tx, manager, writeOff());
      await money.withinLimit(tx, manager, writeOff());
      await money.withinLimit(tx, manager, writeOff());
      expect(approvedBy(manager.id)).toBe(1_950_000);

      settings.dailyLimitOn = true;
      expect(await refusal(money.withinLimit(tx, manager, writeOff()))).toBe(
        dailyLimitMessage(2_600_000, 1_300_000),
      );
    });

    // owner.test.cjs: "the daily total starts fresh each business day".
    it('starts fresh each business date in Jos', async () => {
      const { tx, settings } = fakeTx();
      settings.dailyLimitKobo = 1_000_000;

      await money.withinLimit(tx, manager, writeOff(NOW));
      await expect(
        money.withinLimit(tx, manager, writeOff(NOW)),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        money.withinLimit(tx, manager, writeOff(NEXT)),
      ).resolves.toBeUndefined();
    });

    it('locks the manager’s day before summing it, and inserts after', async () => {
      const { tx, calls } = fakeTx();

      await money.withinLimit(tx, manager, writeOff());

      expect(calls).toEqual(['settings', 'lock', 'sum', 'insert']);
    });
  });
});
