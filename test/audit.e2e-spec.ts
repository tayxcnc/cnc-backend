import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { StaffRole } from '../generated/cnc-client';
import { AuditRefAccess } from '../src/audit/audit-ref-access';
import {
  type AuditEntry,
  AuditService,
  staffActor,
} from '../src/audit/audit.service';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { addDays, formatIsoDate } from '../src/common/calendar-date';
import { watToday } from '../src/common/wat';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp } from './create-test-app';
import {
  type StaffAccount,
  accessTokenFor,
  createStaffAccount,
} from './staff-fixtures';

/**
 * The audit log (C3-5) through HTTP and against Postgres: a row written in
 * the same transaction as its command, `GET /staff/audit` in plain
 * sentences, and plan §4.8's access rules, including the C3 gate's step 4
 * (a Manager sees the Owner's and the Cashier's entries but not another
 * Manager's; the Owner sees all).
 *
 * Every test scopes its reads to a run-unique `ref` (or a run-unique
 * account), because the shared test database holds every other suite's
 * rows too. Nothing is removed: the table is append-only.
 */
describe('audit (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let audit: AuditService;
  let tokens: CncTokenService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    audit = app.get(AuditService, { strict: false });
    tokens = app.get(CncTokenService, { strict: false });

    // A test reader for refs shaped `PROBE-…`: a Cashier may read the ones
    // ending `-OK`, nobody else any. Real readers arrive with the C4
    // modules; until then the registry has none and fails closed.
    app.get(AuditRefAccess, { strict: false }).register({
      owns: (ref) => ref.startsWith('PROBE-'),
      mayRead: (viewer, ref) =>
        Promise.resolve(
          viewer.role === StaffRole.CASHIER && ref.endsWith('-OK'),
        ),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const address = () => `10.${[...randomBytes(3)].join('.')}, 10.255.255.1`;
  const uniqueRef = (prefix = 'AUDIT') => `${prefix}-${randomUUID()}`;

  interface Person extends StaffAccount {
    token: string;
  }

  async function person(role: StaffRole, name?: string): Promise<Person> {
    const account = await createStaffAccount(prisma, role, {
      emailPrefix: 'audit',
      name: name ?? `Audit ${role.toLowerCase()}`,
    });

    return { ...account, token: await accessTokenFor(tokens, account.id) };
  }

  /** Write one row in its own transaction, as a command would. */
  async function write(entry: AuditEntry): Promise<void> {
    await prisma.$transaction((tx) => audit.record(entry, tx));
  }

  const list = (token: string, query: Record<string, string | number> = {}) =>
    request(server())
      .get('/api/v1/staff/audit')
      .set('Authorization', `Bearer ${token}`)
      .query(query);

  interface Row {
    id: string;
    at: string;
    actorName: string;
    actorRole: string | null;
    action: string;
    actionLabel: string;
    module: string;
    ref: string | null;
    reason: string | null;
    changes: string[];
    [key: string]: unknown;
  }

  interface Page {
    data: Row[];
    page: number;
    pageSize: number;
    total: number;
  }

  const pageOf = (response: request.Response) => response.body as Page;
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;
  const namesIn = (response: request.Response) =>
    pageOf(response)
      .data.map((row) => row.actorName)
      .sort();

  describe('who sees whose entries', () => {
    let owner: Person;
    let managerA: Person;
    let managerB: Person;
    let cashier: Person;
    let ref: string;
    const tag = randomUUID().slice(0, 8);
    const systemName = `System ${tag}`;

    beforeAll(async () => {
      owner = await person(StaffRole.OWNER, `Owner ${tag}`);
      managerA = await person(StaffRole.MANAGER, `Manager A ${tag}`);
      managerB = await person(StaffRole.MANAGER, `Manager B ${tag}`);
      cashier = await person(StaffRole.CASHIER, `Cashier ${tag}`);
      ref = uniqueRef();

      for (const who of [owner, managerA, managerB, cashier]) {
        await write({
          actor: staffActor(who),
          action: 'menu.save',
          ref,
          before: { description: '' },
          after: { description: `Saved by ${who.name}` },
        });
      }
      await write({
        actor: { kind: 'SYSTEM', name: systemName },
        action: 'online.status',
        ref,
      });
    });

    // The C3 gate, step 4.
    it("shows a Manager the Owner's and the Cashier's entries but not another Manager's", async () => {
      const response = await list(managerA.token, { ref }).expect(200);

      // Their own, the Owner's, the Cashier's and the system's.
      expect(namesIn(response)).toEqual(
        [owner.name, managerA.name, cashier.name, systemName].sort(),
      );
      expect(pageOf(response).total).toBe(4);
    });

    it('shows the other Manager their own entry and not the first Manager’s', async () => {
      const response = await list(managerB.token, { ref }).expect(200);

      expect(namesIn(response)).toContain(managerB.name);
      expect(namesIn(response)).not.toContain(managerA.name);
      expect(pageOf(response).total).toBe(4);
    });

    it('shows the Owner every entry', async () => {
      const response = await list(owner.token, { ref }).expect(200);

      expect(namesIn(response)).toEqual(
        [
          owner.name,
          managerA.name,
          managerB.name,
          cashier.name,
          systemName,
        ].sort(),
      );
      expect(pageOf(response).total).toBe(5);
    });

    it('judges by the role the entry was made in, not the role held now', async () => {
      const promotedRef = uniqueRef();
      const promoted = await person(StaffRole.MANAGER);
      await write({
        actor: staffActor(promoted),
        action: 'settings.save',
        ref: promotedRef,
      });
      await prisma.staff.update({
        where: { id: promoted.id },
        data: { role: StaffRole.OWNER },
      });

      const response = await list(managerA.token, { ref: promotedRef }).expect(
        200,
      );
      expect(pageOf(response).total).toBe(0);
    });
  });

  describe('the entries', () => {
    it('returns plain sentences and never the raw before and after', async () => {
      const manager = await person(StaffRole.MANAGER);
      const ref = uniqueRef();

      await write({
        actor: staffActor(manager),
        action: 'menu.save',
        ref,
        before: { priceKobo: 250_000, description: '', active: true },
        after: { priceKobo: 300_000, description: 'Smoky', active: false },
        reason: 'Supplier price rise',
        ipAddress: '203.0.113.7',
      });

      const response = await list(manager.token, { ref }).expect(200);
      const page = pageOf(response);

      expect(page).toMatchObject({ page: 1, pageSize: 20, total: 1 });
      expect(Object.keys(page.data[0]).sort()).toEqual([
        'action',
        'actionLabel',
        'actorKind',
        'actorName',
        'actorRole',
        'at',
        'changes',
        'id',
        'module',
        'reason',
        'ref',
        'staffId',
      ]);
      expect(page.data[0]).toMatchObject({
        actorKind: 'STAFF',
        staffId: manager.id,
        actorName: manager.name,
        actorRole: 'MANAGER',
        action: 'menu.save',
        actionLabel: 'Menu Item Saved',
        module: 'Menu & Prices',
        ref,
        reason: 'Supplier price rise',
      });
      // In jsonb's key order (shorter keys first), not the order written.
      expect([...page.data[0].changes].sort()).toEqual(
        [
          'Price changed from ₦2,500 to ₦3,000.',
          'Description changed from blank to Smoky.',
          'Active changed from yes to no.',
        ].sort(),
      );
      expect(JSON.stringify(response.body)).not.toContain('priceKobo');
      expect(JSON.stringify(response.body)).not.toContain('203.0.113.7');
    });

    it('pages newest first without repeating or losing a row', async () => {
      const manager = await person(StaffRole.MANAGER);
      const ref = uniqueRef();

      for (let n = 1; n <= 25; n += 1) {
        await write({
          actor: staffActor(manager),
          action: 'task.save',
          ref,
          reason: `Row ${n}`,
        });
      }

      const seen: Row[] = [];
      for (const page of [1, 2, 3]) {
        const response = await list(manager.token, {
          ref,
          page,
          pageSize: 10,
        }).expect(200);
        const body = pageOf(response);

        expect(body).toMatchObject({ page, pageSize: 10, total: 25 });
        expect(body.data).toHaveLength(page === 3 ? 5 : 10);
        seen.push(...body.data);
      }

      expect(new Set(seen.map((row) => row.id)).size).toBe(25);
      const times = seen.map((row) => Date.parse(row.at));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      expect(seen[0].reason).toBe('Row 25');

      await list(manager.token, { pageSize: 101 }).expect(400);
    });

    it('filters a manager’s read by module, action, staff and WAT dates', async () => {
      const owner = await person(StaffRole.OWNER);
      const cashier = await person(StaffRole.CASHIER);
      const ref = uniqueRef();

      await write({ actor: staffActor(owner), action: 'menu.save', ref });
      await write({ actor: staffActor(cashier), action: 'cash.count', ref });

      const by = async (query: Record<string, string>) =>
        pageOf(await list(owner.token, { ref, ...query }).expect(200)).data.map(
          (row) => row.action,
        );

      expect(await by({ module: 'Point of Sale' })).toEqual(['cash.count']);
      expect(await by({ action: 'menu.save' })).toEqual(['menu.save']);
      expect(await by({ staffId: cashier.id })).toEqual(['cash.count']);

      const today = watToday(new Date());
      expect(
        await by({ from: formatIsoDate(today), to: formatIsoDate(today) }),
      ).toHaveLength(2);
      expect(await by({ from: formatIsoDate(addDays(today, 1)) })).toHaveLength(
        0,
      );
      expect(await by({ to: formatIsoDate(addDays(today, -1)) })).toHaveLength(
        0,
      );

      const backwards = await list(owner.token, {
        from: formatIsoDate(today),
        to: formatIsoDate(addDays(today, -1)),
      }).expect(400);
      expect(messageOf(backwards)).toBe('to must not be before from.');

      const impossible = await list(owner.token, { from: '2026-02-30' }).expect(
        400,
      );
      expect(messageOf(impossible)).toBe(
        'from and to must be real calendar dates.',
      );

      await list(owner.token, { from: '21/10/2026' }).expect(400);
    });
  });

  describe('other roles', () => {
    it('refuses every query but a readable record', async () => {
      const cashier = await person(StaffRole.CASHIER);

      const queries: Record<string, string>[] = [
        {},
        { module: 'Point of Sale' },
        { staffId: cashier.id },
        { from: '2026-10-01' },
        { action: 'order.settle' },
        { action: 'maintenance.save' },
        { ref: uniqueRef('CNCR') },
        { ref: uniqueRef('PROBE') + '-NO' },
        { ref: uniqueRef('PROBE') + '-OK', module: 'Point of Sale' },
      ];

      for (const query of queries) {
        const refused = await list(cashier.token, query).expect(403);
        expect(messageOf(refused)).toBe(ROLE_REFUSED_MESSAGE);
      }
    });

    it("shows a readable record's whole history, managers' entries included", async () => {
      const cashier = await person(StaffRole.CASHIER);
      const manager = await person(StaffRole.MANAGER);
      const ref = `${uniqueRef('PROBE')}-OK`;

      await write({ actor: staffActor(cashier), action: 'order.create', ref });
      await write({
        actor: staffActor(manager),
        action: 'order.discount',
        ref,
        reason: 'Staff meal',
      });

      const response = await list(cashier.token, { ref }).expect(200);
      expect(pageOf(response).total).toBe(2);
      expect(namesIn(response)).toEqual([cashier.name, manager.name].sort());

      // Another role may not read it.
      const waiter = await person(StaffRole.WAITER);
      await list(waiter.token, { ref }).expect(403);
    });

    it('lets Reception read the repair history, and nothing else without a ref', async () => {
      const reception = await person(StaffRole.RECEPTION);
      const ref = uniqueRef('MT');

      await write({
        actor: staffActor(reception),
        action: 'maintenance.save',
        ref,
      });
      await write({ actor: staffActor(reception), action: 'task.save', ref });

      const response = await list(reception.token, {
        action: 'maintenance.save',
        ref,
      }).expect(200);
      expect(pageOf(response).data.map((row) => row.action)).toEqual([
        'maintenance.save',
      ]);

      await list(reception.token, { action: 'maintenance.save' }).expect(200);
      await list(reception.token, { action: 'task.save' }).expect(403);
      await list(reception.token, {
        action: 'maintenance.save',
        from: '2026-10-01',
      }).expect(403);
    });

    it('refuses a request with no token', async () => {
      await request(server()).get('/api/v1/staff/audit').expect(401);
    });
  });

  describe('written in the command’s transaction', () => {
    const rowsFor = (staffNo: string, action: string) =>
      prisma.auditLog.findMany({ where: { ref: staffNo, action } });

    it('records a password change with the address, and nothing for a refused one', async () => {
      const cashier = await person(StaffRole.CASHIER);
      const from = address();

      await request(server())
        .post('/api/v1/auth/staff/change-password')
        .set('X-Forwarded-For', from)
        .set('Authorization', `Bearer ${cashier.token}`)
        .send({
          currentPassword: 'wrong-password',
          newPassword: 'x'.repeat(12),
        })
        .expect(401);
      expect(await rowsFor(cashier.staffNo, 'staff.changePassword')).toEqual(
        [],
      );

      const newPassword = `new-${randomUUID()}`;
      await request(server())
        .post('/api/v1/auth/staff/change-password')
        .set('X-Forwarded-For', from)
        .set('Authorization', `Bearer ${cashier.token}`)
        .send({ currentPassword: cashier.password, newPassword })
        .expect(200);

      const rows = await rowsFor(cashier.staffNo, 'staff.changePassword');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorKind: 'STAFF',
        staffId: cashier.id,
        actorName: cashier.name,
        actorRole: 'CASHIER',
        module: 'Staff & Access',
        ipAddress: from.split(',')[0],
      });
      expect(JSON.stringify(rows[0])).not.toContain(newPassword);
      expect(JSON.stringify(rows[0])).not.toContain(cashier.password);
    });

    it('records an admin reset, never the password, and nothing for a refused one', async () => {
      const owner = await person(StaffRole.OWNER);
      const manager = await person(StaffRole.MANAGER);
      const otherManager = await person(StaffRole.MANAGER);
      const reset = (by: Person, target: Person) =>
        request(server())
          .post(`/api/v1/staff/people/${target.id}/reset-password`)
          .set('X-Forwarded-For', address())
          .set('Authorization', `Bearer ${by.token}`)
          .send();

      await reset(manager, otherManager).expect(403);
      expect(
        await rowsFor(otherManager.staffNo, 'staff.resetPassword'),
      ).toEqual([]);

      const response = await reset(owner, otherManager).expect(200);
      const { temporaryPassword } = response.body as {
        temporaryPassword: string;
      };

      const rows = await rowsFor(otherManager.staffNo, 'staff.resetPassword');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ staffId: owner.id, actorRole: 'OWNER' });
      expect(JSON.stringify(rows[0])).not.toContain(temporaryPassword);

      const read = await list(owner.token, {
        ref: otherManager.staffNo,
        action: 'staff.resetPassword',
      }).expect(200);
      expect(pageOf(read).data[0]).toMatchObject({
        actionLabel: 'Password Reset',
        changes: ['Must Change Password changed from no to yes.'],
      });
    });

    it('leaves no row when the command’s transaction rolls back', async () => {
      const manager = await person(StaffRole.MANAGER);
      const ref = uniqueRef();

      await expect(
        prisma.$transaction(async (tx) => {
          await audit.record(
            { actor: staffActor(manager), action: 'menu.save', ref },
            tx,
          );
          throw new Error('The command failed after its audit row.');
        }),
      ).rejects.toThrow('The command failed');

      await expect(prisma.auditLog.count({ where: { ref } })).resolves.toBe(0);
    });

    it('refuses to write a credential, and writes nothing', async () => {
      const manager = await person(StaffRole.MANAGER);
      const ref = uniqueRef();

      await expect(
        write({
          actor: staffActor(manager),
          action: 'staff.save',
          ref,
          after: { passwordHash: 'not-a-real-hash' },
        }),
      ).rejects.toThrow('"passwordHash"');

      await expect(prisma.auditLog.count({ where: { ref } })).resolves.toBe(0);
    });
  });
});
