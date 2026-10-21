import { ForbiddenException } from '@nestjs/common';
import { PrinterWidth, StaffRole } from '../../generated/cnc-client';
import type { AuditEntry, AuditService } from '../audit/audit.service';
import type { StaffPrincipal } from '../auth/staff-principal';
import {
  MoneyControlService,
  OWNER_ONLY_SETTINGS_MESSAGE,
  OWNER_ONLY_TIMES_MESSAGE,
} from '../money-control/money-control.service';
import type { CncPrismaService } from '../prisma/cnc-prisma.service';
import type { UpdateSettingsRequest } from './dto/update-settings.request';
import { OWNER_MONEY_SETTINGS, OWNER_TIME_SETTINGS } from './settings-rules';
import { SettingsService } from './settings.service';

/**
 * `settings.save`'s Owner rules, ported from `owner.test.cjs` ("a manager
 * keeps printer, alerts and the free table reminder but not tax, delivery
 * or the limit"), against a fake transaction. The e2e suite runs them
 * through the route.
 */

const owner: StaffPrincipal = {
  id: 'owner-1',
  staffNo: 'CNC-S001',
  name: 'Sandra Silas',
  role: StaffRole.OWNER,
};
const manager: StaffPrincipal = {
  id: 'manager-1',
  staffNo: 'CNC-S002',
  name: 'Ada Okafor',
  role: StaffRole.MANAGER,
};

/** The Q7 values. */
const STORED = {
  id: 'settings-1',
  vatBps: 750,
  serviceBps: 0,
  depositKobo: 0,
  freeTableReminderMinutes: 180,
  deliveryJosKobo: 500000,
  deliveryOutsideKobo: 1000000,
  approvalLimitKobo: 5000000,
  dailyLimitOn: true,
  dailyLimitKobo: 15000000,
  printerWidth: PrinterWidth.MM80,
  alertLowStock: true,
  alertApprovals: true,
  alertUnsettled: true,
  alertArrivals: true,
  lastArrivalMinutes: 1380,
  lastOrderSlotMinutes: 1410,
  slotStepMinutes: 30,
  leadPickupMinutes: 60,
  leadJosMinutes: 90,
  leadOutsideMinutes: 120,
  updatedAt: new Date('2026-10-20T00:00:00.000Z'),
  version: 4,
};

/** A different value of the same type, for any key. */
function changed(key: keyof typeof STORED): unknown {
  const value = STORED[key];
  return typeof value === 'boolean' ? !value : (value as number) + 1;
}

function setup() {
  let current = { ...STORED };
  const written: Record<string, unknown>[] = [];
  const audits: AuditEntry[] = [];

  const tx = {
    $queryRawUnsafe: jest.fn(() => {
      current = { ...current, version: current.version + 1 };
      return Promise.resolve([{ version: current.version }]);
    }),
    settings: {
      findUnique: jest.fn(() => Promise.resolve({ id: current.id })),
      findUniqueOrThrow: jest.fn(() => Promise.resolve({ ...current })),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        written.push(data);
        current = { ...current, ...data };
        return Promise.resolve({ ...current });
      }),
    },
  };

  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };
  const audit: Pick<AuditService, 'record'> = {
    record: jest.fn((entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  };

  const service = new SettingsService(
    prisma as unknown as CncPrismaService,
    audit,
    new MoneyControlService(),
  );

  return { service, written, audits };
}

const save = (
  actor: StaffPrincipal,
  body: Partial<UpdateSettingsRequest>,
  service = setup().service,
) => service.save(actor, { version: 4, ...body }, '10.0.0.1');

describe('SettingsService.save', () => {
  it('lets a manager change the printer, the alerts and the free table reminder', async () => {
    const { service, written } = setup();

    const result = await save(
      manager,
      {
        printerWidth: PrinterWidth.MM58,
        freeTableReminderMinutes: 120,
        alertArrivals: false,
      },
      service,
    );

    expect(result).toMatchObject({
      printerWidth: PrinterWidth.MM58,
      freeTableReminderMinutes: 120,
      alertArrivals: false,
      version: 5,
    });
    expect(written).toEqual([
      {
        freeTableReminderMinutes: 120,
        printerWidth: PrinterWidth.MM58,
        alertArrivals: false,
      },
    ]);
  });

  it.each(OWNER_MONEY_SETTINGS)(
    'refuses a manager changing %s, with the demo’s sentence, and writes nothing',
    async (key) => {
      const { service, written } = setup();

      await expect(
        save(manager, { [key]: changed(key) }, service),
      ).rejects.toEqual(new ForbiddenException(OWNER_ONLY_SETTINGS_MESSAGE));
      expect(written).toEqual([]);
    },
  );

  it.each(OWNER_TIME_SETTINGS)(
    'refuses a manager changing %s, with Q29’s sentence',
    async (key) => {
      await expect(save(manager, { [key]: changed(key) })).rejects.toEqual(
        new ForbiddenException(OWNER_ONLY_TIMES_MESSAGE),
      );
    },
  );

  it('lets a manager send every Owner-only key unchanged with the form', async () => {
    const unchanged = Object.fromEntries(
      [...OWNER_MONEY_SETTINGS, ...OWNER_TIME_SETTINGS].map((key) => [
        key,
        STORED[key],
      ]),
    );

    await expect(
      save(manager, { ...unchanged, printerWidth: PrinterWidth.A4 }),
    ).resolves.toMatchObject({ printerWidth: PrinterWidth.A4, vatBps: 750 });
  });

  it('checks the money keys first, as the demo does', async () => {
    await expect(
      save(manager, { vatBps: 800, leadJosMinutes: 100 }),
    ).rejects.toEqual(new ForbiddenException(OWNER_ONLY_SETTINGS_MESSAGE));
  });

  it('lets the Owner change any key, and audits the before and after', async () => {
    const { service, audits } = setup();

    await save(
      owner,
      { vatBps: 800, approvalLimitKobo: 2000000, leadJosMinutes: 100 },
      service,
    );

    expect(audits[0]).toMatchObject({
      action: 'settings.save',
      before: { vatBps: 750, approvalLimitKobo: 5000000, leadJosMinutes: 90 },
      after: { vatBps: 800, approvalLimitKobo: 2000000, leadJosMinutes: 100 },
    });
  });
});
