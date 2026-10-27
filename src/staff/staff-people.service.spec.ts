import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { StaffRole, SubjectType } from '../../generated/cnc-client';
import { FakeMediaStorage } from '../../test/fake-media-storage';
import type { AuditEntry, AuditService } from '../audit/audit.service';
import type { CncTokenService } from '../auth/cnc-token.service';
import { verifyPassword } from '../auth/password';
import type { StaffPrincipal } from '../auth/staff-principal';
import { ImageResizerService } from '../images/image-resizer.service';
import { PhotoStore } from '../images/photo-store.service';
import {
  LAST_ACTIVE_OWNER_MESSAGE,
  MoneyControlService,
  OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE,
} from '../money-control/money-control.service';
import type { CncPrismaService } from '../prisma/cnc-prisma.service';
import {
  OWN_PHOTO_ONLY_MESSAGE,
  STAFF_EMAIL_REASON_MESSAGE,
  STAFF_EMAIL_TAKEN_MESSAGE,
  STAFF_NAME_REASON_MESSAGE,
} from './staff-messages';
import { StaffPeopleService } from './staff-people.service';

/**
 * `staff.save`'s rules in the demo's order, against a fake transaction that
 * records what was called. The e2e suite runs them against Postgres; this
 * covers what a shared test database cannot set up safely: the last active
 * Owner (the shared database always holds other Owners), and the exact
 * writes each refusal prevents.
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
const cashier: StaffPrincipal = {
  id: 'cashier-1',
  staffNo: 'CNC-S003',
  name: 'Grace James',
  role: StaffRole.CASHIER,
};

interface Row {
  id: string;
  staffNo: string;
  name: string;
  email: string;
  role: StaffRole;
  isActive: boolean;
  mustChangePassword: boolean;
  photo: string | null;
  joinedOn: Date;
  qrRegeneratedAt: Date | null;
  version: number;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'target-1',
    staffNo: 'CNC-S010',
    name: 'Samuel Peter',
    email: 'samuel@cnc.example',
    role: StaffRole.WAITER,
    isActive: true,
    mustChangePassword: false,
    photo: null,
    joinedOn: new Date('2026-10-01T00:00:00.000Z'),
    qrRegeneratedAt: null,
    version: 3,
    ...overrides,
  };
}

function setup(
  stored: Row,
  options: { emailHolder?: string; otherActiveOwners?: number } = {},
) {
  const calls: string[] = [];
  let current = { ...stored };
  const created: Record<string, unknown>[] = [];
  const audits: AuditEntry[] = [];

  const tx = {
    $queryRawUnsafe: jest.fn((sql: string) => {
      if (sql.includes('nextval')) {
        calls.push('number');
        return Promise.resolve([{ next: 11n }]);
      }
      calls.push('claim');
      current = { ...current, version: current.version + 1 };
      return Promise.resolve([{ version: current.version }]);
    }),
    $executeRaw: jest.fn(() => {
      calls.push('owner-lock');
      return Promise.resolve(1);
    }),
    staff: {
      findUniqueOrThrow: jest.fn(() => Promise.resolve({ ...current })),
      findUnique: jest.fn(() =>
        Promise.resolve(
          options.emailHolder ? { id: options.emailHolder } : null,
        ),
      ),
      count: jest.fn(() => {
        calls.push('owner-count');
        return Promise.resolve(options.otherActiveOwners ?? 1);
      }),
      update: jest.fn(({ data }: { data: Partial<Row> }) => {
        calls.push('update');
        current = { ...current, ...data };
        return Promise.resolve({ ...current });
      }),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        calls.push('create');
        created.push(data);
        return Promise.resolve(
          row({
            id: 'new-1',
            staffNo: data.staffNo as string,
            name: data.name as string,
            email: data.email as string,
            role: data.role as StaffRole,
            isActive: data.isActive as boolean,
            mustChangePassword: true,
            version: 0,
          }),
        );
      }),
    },
  };

  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };
  const tokens = {
    revokeAllForSubject: jest.fn(() => {
      calls.push('revoke');
      return Promise.resolve(1);
    }),
  };
  const audit: Pick<AuditService, 'record'> = {
    record: jest.fn((entry: AuditEntry) => {
      calls.push('audit');
      audits.push(entry);
      return Promise.resolve();
    }),
  };
  const storage = new FakeMediaStorage();

  const service = new StaffPeopleService(
    prisma as unknown as CncPrismaService,
    tokens as unknown as CncTokenService,
    audit,
    new MoneyControlService(),
    new PhotoStore(storage, new ImageResizerService()),
  );

  return { service, calls, tx, tokens, audits, created, storage, prisma };
}

describe('StaffPeopleService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('staff.save on an existing account', () => {
    it('takes the row first, then writes, revokes nothing for a name fix, and audits', async () => {
      const { service, calls, tx, audits } = setup(row());

      const result = await service.update(
        manager,
        'target-1',
        { version: 3, name: 'Samuel Peters', reason: 'Spelling' },
        '10.0.0.1',
      );

      expect(calls).toEqual(['claim', 'update', 'audit']);
      expect(result.version).toBe(4);
      expect(tx.staff.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            name: 'Samuel Peters',
            email: 'samuel@cnc.example',
            role: StaffRole.WAITER,
            isActive: true,
          },
        }),
      );
      expect(audits[0]).toMatchObject({
        action: 'staff.save',
        ref: 'CNC-S010',
        reason: 'Spelling',
        before: { name: 'Samuel Peter', isActive: true, hasPhoto: false },
        after: { name: 'Samuel Peters' },
      });
    });

    it('leaves a deactivated account deactivated when the status is not sent (R2)', async () => {
      const { service, tx, tokens } = setup(row({ isActive: false }));

      const result = await service.update(
        manager,
        'target-1',
        { version: 3, name: 'Samuel Peters', reason: 'Spelling' },
        '10.0.0.1',
      );

      expect(result.isActive).toBe(false);
      expect(tx.staff.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isActive: false }) as unknown,
        }),
      );
      expect(tokens.revokeAllForSubject).not.toHaveBeenCalled();
    });

    it.each([
      ['a deactivation', { isActive: false }],
      ['a role change', { role: StaffRole.CASHIER }],
      [
        'an email change',
        { email: 'samuel.peter@cnc.example', reason: 'New address' },
      ],
    ])(
      'ends every session on %s, inside the transaction',
      async (_what, change) => {
        const { service, calls, tokens, tx } = setup(row());

        await service.update(
          manager,
          'target-1',
          { version: 3, ...change },
          '10.0.0.1',
        );

        expect(calls).toEqual(['claim', 'update', 'revoke', 'audit']);
        expect(tokens.revokeAllForSubject).toHaveBeenCalledWith(
          'target-1',
          SubjectType.STAFF,
          tx,
        );
      },
    );

    it('refuses a Manager changing a Manager account, and writes nothing', async () => {
      const { service, calls } = setup(row({ role: StaffRole.MANAGER }));

      await expect(
        service.update(
          manager,
          'target-1',
          { version: 3, name: 'Other', reason: 'x' },
          '10.0.0.1',
        ),
      ).rejects.toEqual(
        new ForbiddenException(OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE),
      );
      expect(calls).toEqual(['claim']);
    });

    it('refuses a Manager making someone a Manager', async () => {
      const { service } = setup(row());

      await expect(
        service.update(
          manager,
          'target-1',
          { version: 3, role: StaffRole.MANAGER },
          '10.0.0.1',
        ),
      ).rejects.toEqual(
        new ForbiddenException(OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE),
      );
    });

    it('asks for a reason to change an email or a name, in the demo’s words', async () => {
      await expect(
        setup(row()).service.update(
          manager,
          'target-1',
          { version: 3, email: 'new@cnc.example' },
          '10.0.0.1',
        ),
      ).rejects.toEqual(new BadRequestException(STAFF_EMAIL_REASON_MESSAGE));

      await expect(
        setup(row()).service.update(
          manager,
          'target-1',
          { version: 3, name: 'Someone Else', reason: '   ' },
          '10.0.0.1',
        ),
      ).rejects.toEqual(new BadRequestException(STAFF_NAME_REASON_MESSAGE));
    });

    it('refuses an email another account holds, before asking for a reason', async () => {
      const { service } = setup(row(), { emailHolder: 'someone-else' });

      await expect(
        service.update(
          manager,
          'target-1',
          { version: 3, email: 'taken@cnc.example' },
          '10.0.0.1',
        ),
      ).rejects.toEqual(new ConflictException(STAFF_EMAIL_TAKEN_MESSAGE));
    });

    it('refuses demoting or deactivating the last active Owner, after the lock, and writes nothing', async () => {
      for (const change of [{ role: StaffRole.MANAGER }, { isActive: false }]) {
        const { service, calls } = setup(
          row({ id: 'owner-1', role: StaffRole.OWNER }),
          { otherActiveOwners: 0 },
        );

        await expect(
          service.update(
            owner,
            'owner-1',
            { version: 3, ...change },
            '10.0.0.1',
          ),
        ).rejects.toEqual(new ForbiddenException(LAST_ACTIVE_OWNER_MESSAGE));
        expect(calls).toEqual(['claim', 'owner-lock', 'owner-count']);
      }
    });

    it('lets an Owner step down while another active Owner exists', async () => {
      const { service, calls } = setup(
        row({ id: 'owner-1', role: StaffRole.OWNER }),
        { otherActiveOwners: 1 },
      );

      const result = await service.update(
        owner,
        'owner-1',
        { version: 3, role: StaffRole.MANAGER },
        '10.0.0.1',
      );

      expect(result.role).toBe(StaffRole.MANAGER);
      expect(calls).toEqual([
        'claim',
        'owner-lock',
        'owner-count',
        'update',
        'revoke',
        'audit',
      ]);
    });
  });

  describe('staff.save for a new person', () => {
    it('refuses a Manager creating a Manager or an Owner before any work', async () => {
      for (const role of [StaffRole.MANAGER, StaffRole.OWNER]) {
        const { service, prisma } = setup(row());

        await expect(
          service.create(
            manager,
            { name: 'New', email: 'new@cnc.example', role },
            '10.0.0.1',
          ),
        ).rejects.toEqual(
          new ForbiddenException(OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      }
    });

    it('creates the account with a temporary password, a QR token and the next number, and returns the password once', async () => {
      const { service, created, audits, calls } = setup(row());

      const result = await service.create(
        manager,
        {
          name: 'New Cashier',
          email: 'new@cnc.example',
          role: StaffRole.CASHIER,
        },
        '10.0.0.1',
      );

      expect(calls).toEqual(['number', 'create', 'audit']);
      expect(result.temporaryPassword).toMatch(
        /^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/,
      );
      expect(created[0]).toMatchObject({
        staffNo: 'CNC-S011',
        mustChangePassword: true,
        isActive: true,
      });
      expect(created[0].qrToken).toEqual(expect.any(String));
      await expect(
        verifyPassword(
          created[0].passwordHash as string,
          result.temporaryPassword,
        ),
      ).resolves.toBe(true);

      const answered = JSON.stringify(result.staff);
      expect(answered).not.toContain('passwordHash');
      expect(answered).not.toContain('qrToken');
      expect(answered).not.toContain(result.temporaryPassword);
      expect(JSON.stringify(audits)).not.toContain(result.temporaryPassword);
    });
  });

  describe('staff.photo and the ID reissue', () => {
    it('refuses someone else’s photo to a non-manager before storing anything', async () => {
      const { service, storage, prisma } = setup(row());

      await expect(
        service.removePhoto(cashier, 'target-1', 3, '10.0.0.1'),
      ).rejects.toEqual(new ForbiddenException(OWN_PHOTO_ONLY_MESSAGE));
      await expect(
        service.replacePhoto(
          cashier,
          'target-1',
          3,
          { buffer: Buffer.from('x') },
          '10.0.0.1',
        ),
      ).rejects.toEqual(new ForbiddenException(OWN_PHOTO_ONLY_MESSAGE));

      expect(storage.objects.size).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('reissues an ID with a new token, and audits only when, never the token', async () => {
      const { service, tx, audits } = setup(row());

      const result = await service.regenerateQr(
        manager,
        'target-1',
        3,
        '10.0.0.1',
      );

      const data = (
        tx.staff.update.mock.calls[0] as unknown as [
          { data: { qrToken: string; qrRegeneratedAt: Date } },
        ]
      )[0].data;

      expect(data.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.qrRegeneratedAt).toEqual(data.qrRegeneratedAt);
      expect(JSON.stringify(result)).not.toContain(data.qrToken);
      expect(audits[0]).toMatchObject({
        action: 'staff.regenerateQr',
        before: { qrRegeneratedAt: null },
        after: { qrRegeneratedAt: data.qrRegeneratedAt },
      });
      expect(JSON.stringify(audits)).not.toContain(data.qrToken);
    });

    it('keeps a Manager or Owner ID reissue for the Owner', async () => {
      const { service } = setup(row({ role: StaffRole.OWNER }));

      await expect(
        service.regenerateQr(manager, 'target-1', 3, '10.0.0.1'),
      ).rejects.toEqual(
        new ForbiddenException(OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE),
      );
    });
  });
});
