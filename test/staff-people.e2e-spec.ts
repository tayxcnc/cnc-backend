import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types';
import { StaffRole, SubjectType } from '../generated/cnc-client';
import { CncTokenService } from '../src/auth/cnc-token.service';
import { STAFF_DEACTIVATED_MESSAGE } from '../src/auth/guards/cnc-staff.guard';
import { verifyPassword } from '../src/auth/password';
import { STAFF_NOT_FOUND_MESSAGE } from '../src/auth/staff-auth.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import {
  PHOTO_MISSING_MESSAGE,
  PHOTO_TOO_LARGE_MESSAGE,
  PHOTO_UNSUPPORTED_MESSAGE,
} from '../src/images/uploaded-image';
import { OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE } from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { STALE_VERSION_MESSAGE } from '../src/prisma/optimistic-version';
import {
  OWN_PHOTO_ONLY_MESSAGE,
  STAFF_EMAIL_INVALID_MESSAGE,
  STAFF_EMAIL_REASON_MESSAGE,
  STAFF_EMAIL_TAKEN_MESSAGE,
  STAFF_NAME_AND_ROLE_MESSAGE,
  STAFF_NAME_REASON_MESSAGE,
} from '../src/staff/staff-messages';
import { MediaStorage } from '../src/storage/media-storage';
import { createTestApp } from './create-test-app';
import { FakeMediaStorage } from './fake-media-storage';
import { testSubscription } from './push-devices';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';
import { testImage } from './test-images';

/**
 * Staff & Access (C3-6) through HTTP and against Postgres: `staff.save`
 * (create, change, role, deactivation), `staff.photo` and the ID reissue,
 * with the C3 gate's steps 2 and 5.
 *
 * Every account is run-unique and left in the shared test database. The
 * last-active-Owner refusal is in the unit spec: this database always
 * holds other active Owners, and committing their deactivation would break
 * every other suite.
 */
describe('Staff & Access (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;
  let storage: FakeMediaStorage;

  interface Person {
    id: string;
    staffNo: string;
    email: string;
    token: string;
  }

  let owner: Person;
  let manager: Person;
  let cashier: Person;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService, { strict: false });
    storage = app.get<MediaStorage, FakeMediaStorage>(MediaStorage, {
      strict: false,
    });

    owner = await person(StaffRole.OWNER);
    manager = await person(StaffRole.MANAGER);
    cashier = await person(StaffRole.CASHIER);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const unique = () => randomUUID().slice(0, 8);
  const emailFor = (prefix: string) => `${prefix}-${randomUUID()}@cnc.test`;

  async function person(role: StaffRole): Promise<Person> {
    const account = await createStaffAccount(prisma, role, {
      emailPrefix: 'people',
      name: `People ${role.toLowerCase()} ${unique()}`,
    });

    return {
      id: account.id,
      staffNo: account.staffNo,
      email: account.email,
      token: await accessTokenFor(tokens, account.id),
    };
  }

  const as = (who: Person) => ({ Authorization: `Bearer ${who.token}` });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  interface Account {
    id: string;
    staffNo: string;
    name: string;
    email: string;
    role: StaffRole;
    isActive: boolean;
    mustChangePassword: boolean;
    photoUrl: string | null;
    joinedOn: string;
    qrRegeneratedAt: string | null;
    version: number;
  }

  const create = (by: Person, body: Record<string, unknown>) =>
    request(server()).post('/api/v1/staff/people').set(as(by)).send(body);

  const patch = (by: Person, id: string, body: Record<string, unknown>) =>
    request(server())
      .patch(`/api/v1/staff/people/${id}`)
      .set(as(by))
      .send(body);

  async function hire(
    role: StaffRole = StaffRole.WAITER,
    by: Person = owner,
  ): Promise<Account> {
    const response = await create(by, {
      name: `Hire ${unique()}`,
      email: emailFor('hire'),
      role,
    }).expect(201);

    return (response.body as { staff: Account }).staff;
  }

  describe('creating an account', () => {
    it('lets a manager create a Cashier with a temporary password, a number and an ID (gate step 2)', async () => {
      const email = emailFor('Grace.James');
      const response = await create(manager, {
        name: '  Grace James  ',
        email: `  ${email.toUpperCase()} `,
        role: StaffRole.CASHIER,
      }).expect(201);

      const body = response.body as {
        staff: Account;
        temporaryPassword: string;
      };

      expect(Object.keys(body).sort()).toEqual(['staff', 'temporaryPassword']);
      expect(Object.keys(body.staff).sort()).toEqual(
        [
          'email',
          'id',
          'isActive',
          'joinedOn',
          'mustChangePassword',
          'name',
          'photoUrl',
          'qrRegeneratedAt',
          'role',
          'staffNo',
          'version',
        ].sort(),
      );
      expect(body.staff).toMatchObject({
        name: 'Grace James',
        email: email.toLowerCase(),
        role: StaffRole.CASHIER,
        isActive: true,
        mustChangePassword: true,
        photoUrl: null,
        qrRegeneratedAt: null,
        version: 0,
      });
      expect(body.staff.staffNo).toMatch(/^CNC-S\d{3,}$/);
      expect(body.temporaryPassword).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);

      const stored = await prisma.staff.findUniqueOrThrow({
        where: { id: body.staff.id },
      });
      await expect(
        verifyPassword(stored.passwordHash, body.temporaryPassword),
      ).resolves.toBe(true);
      expect(stored.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(response.body)).not.toContain(stored.qrToken);
      expect(JSON.stringify(response.body)).not.toContain(stored.passwordHash);

      const [entry] = await prisma.auditLog.findMany({
        where: { ref: body.staff.staffNo, action: 'staff.save' },
      });
      expect(entry).toMatchObject({
        staffId: manager.id,
        actorRole: StaffRole.MANAGER,
        module: 'Staff & Access',
        before: null,
      });
      expect(JSON.stringify(entry.after)).not.toContain(body.temporaryPassword);
    });

    it('keeps Manager and Owner accounts for the Owner (gate step 2)', async () => {
      for (const role of [StaffRole.MANAGER, StaffRole.OWNER]) {
        const refused = await create(manager, {
          name: 'Second Manager',
          email: emailFor('second'),
          role,
        }).expect(403);
        expect(messageOf(refused)).toBe(OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE);
      }

      const created = await create(owner, {
        name: 'Manager A',
        email: emailFor('manager-a'),
        role: StaffRole.MANAGER,
      }).expect(201);
      expect((created.body as { staff: Account }).staff.role).toBe(
        StaffRole.MANAGER,
      );
    });

    it('refuses an email another account holds, whatever its case', async () => {
      const response = await create(manager, {
        name: 'Copy',
        email: cashier.email.toUpperCase(),
        role: StaffRole.WAITER,
      }).expect(409);

      expect(messageOf(response)).toBe(STAFF_EMAIL_TAKEN_MESSAGE);
    });

    it('answers a missing name, an unknown role and a bad email in the demo’s words', async () => {
      const noName = await create(manager, {
        name: '   ',
        email: emailFor('x'),
        role: StaffRole.WAITER,
      }).expect(400);
      expect(messageOf(noName)).toContain(STAFF_NAME_AND_ROLE_MESSAGE);

      const badRole = await create(manager, {
        name: 'X',
        email: emailFor('x'),
        role: 'CHEF',
      }).expect(400);
      expect(messageOf(badRole)).toContain(STAFF_NAME_AND_ROLE_MESSAGE);

      const badEmail = await create(manager, {
        name: 'X',
        email: 'not an email',
        role: StaffRole.WAITER,
      }).expect(400);
      expect(messageOf(badEmail)).toContain(STAFF_EMAIL_INVALID_MESSAGE);
    });

    it('refuses everyone but managers', async () => {
      const response = await create(cashier, {
        name: 'X',
        email: emailFor('x'),
        role: StaffRole.WAITER,
      }).expect(403);

      expect(messageOf(response)).toBe(ROLE_REFUSED_MESSAGE);
    });
  });

  describe('changing an account', () => {
    it('asks for a reason to correct a name or an email, and records it', async () => {
      const account = await hire();

      const noReason = await patch(manager, account.id, {
        version: account.version,
        name: 'Corrected Name',
      }).expect(400);
      expect(messageOf(noReason)).toBe(STAFF_NAME_REASON_MESSAGE);

      const noEmailReason = await patch(manager, account.id, {
        version: account.version,
        email: emailFor('new'),
      }).expect(400);
      expect(messageOf(noEmailReason)).toBe(STAFF_EMAIL_REASON_MESSAGE);

      const saved = await patch(manager, account.id, {
        version: account.version,
        name: 'Corrected Name',
        reason: 'Spelling from her ID card',
      }).expect(200);
      expect(saved.body as Account).toMatchObject({
        name: 'Corrected Name',
        version: account.version + 1,
      });

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { ref: account.staffNo, reason: 'Spelling from her ID card' },
      });
      expect(entry.action).toBe('staff.save');
    });

    it('refuses an email another account holds', async () => {
      const account = await hire();

      const response = await patch(manager, account.id, {
        version: account.version,
        email: cashier.email,
        reason: 'Typo',
      }).expect(409);

      expect(messageOf(response)).toBe(STAFF_EMAIL_TAKEN_MESSAGE);
    });

    it('keeps a deactivated account deactivated when a save does not send the status (R2)', async () => {
      const account = await hire();

      const off = await patch(owner, account.id, {
        version: account.version,
        isActive: false,
      }).expect(200);

      const renamed = await patch(owner, account.id, {
        version: (off.body as Account).version,
        name: 'Renamed While Off',
        reason: 'Correction',
      }).expect(200);

      expect((renamed.body as Account).isActive).toBe(false);
    });

    it('keeps Manager accounts for the Owner, demotion included', async () => {
      const managerAccount = await hire(StaffRole.MANAGER);

      const refused = await patch(manager, managerAccount.id, {
        version: managerAccount.version,
        role: StaffRole.CASHIER,
      }).expect(403);
      expect(messageOf(refused)).toBe(OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE);

      const promote = await hire(StaffRole.WAITER);
      const refusedPromotion = await patch(manager, promote.id, {
        version: promote.version,
        role: StaffRole.MANAGER,
      }).expect(403);
      expect(messageOf(refusedPromotion)).toBe(
        OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE,
      );
    });

    it('answers a stale version with 409 and an unknown account with 404', async () => {
      const account = await hire();

      await patch(manager, account.id, {
        version: account.version,
        isActive: true,
      }).expect(200);

      const stale = await patch(manager, account.id, {
        version: account.version,
        isActive: true,
      }).expect(409);
      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);

      const missing = await patch(manager, 'no-such-account', {
        version: 0,
        isActive: true,
      }).expect(404);
      expect(messageOf(missing)).toBe(STAFF_NOT_FOUND_MESSAGE);
    });

    it('lets an Owner step down while another active Owner exists', async () => {
      const stepping = await person(StaffRole.OWNER);
      const row = await prisma.staff.findUniqueOrThrow({
        where: { id: stepping.id },
      });

      const response = await patch(stepping, stepping.id, {
        version: row.version,
        role: StaffRole.MANAGER,
      }).expect(200);

      expect((response.body as Account).role).toBe(StaffRole.MANAGER);
    });
  });

  describe('deactivation and sessions (gate step 5)', () => {
    it('refuses a deactivated Manager’s next action and ends their sessions', async () => {
      const managerB = await person(StaffRole.MANAGER);
      await tokens.issueTokenPair(managerB.id, SubjectType.STAFF);

      await request(server())
        .get('/api/v1/staff/people')
        .set(as(managerB))
        .expect(200);

      const row = await prisma.staff.findUniqueOrThrow({
        where: { id: managerB.id },
      });
      await patch(owner, managerB.id, {
        version: row.version,
        isActive: false,
      }).expect(200);

      const refused = await request(server())
        .get('/api/v1/staff/people')
        .set(as(managerB))
        .expect(403);
      expect(messageOf(refused)).toBe(STAFF_DEACTIVATED_MESSAGE);

      const live = await prisma.refreshToken.count({
        where: { subjectId: managerB.id, revokedAt: null },
      });
      expect(live).toBe(0);
    });

    it('ends sessions on a role change but not on a name correction', async () => {
      const account = await person(StaffRole.WAITER);
      await tokens.issueTokenPair(account.id, SubjectType.STAFF);
      const live = () =>
        prisma.refreshToken.count({
          where: { subjectId: account.id, revokedAt: null },
        });

      const sessions = await live();
      expect(sessions).toBeGreaterThan(0);

      const before = await prisma.staff.findUniqueOrThrow({
        where: { id: account.id },
      });
      const renamed = await patch(manager, account.id, {
        version: before.version,
        name: `Renamed ${unique()}`,
        reason: 'Correction',
      }).expect(200);
      expect(await live()).toBe(sessions);

      await patch(manager, account.id, {
        version: (renamed.body as Account).version,
        role: StaffRole.CASHIER,
      }).expect(200);
      expect(await live()).toBe(0);
    });

    it('forgets the push devices on a role change and a deactivation, and the still-valid access token cannot bind one again (C10)', async () => {
      const devices = (staffId: string) =>
        prisma.staffPushSubscription.count({ where: { staffId } });
      const subscribe = (who: Person, status: number) =>
        request(server())
          .post('/api/v1/staff/push/subscriptions')
          .set(as(who))
          .send(testSubscription())
          .expect(status);

      const moved = await person(StaffRole.KITCHEN);

      await subscribe(moved, 204);
      expect(await devices(moved.id)).toBe(1);

      const row = await prisma.staff.findUniqueOrThrow({
        where: { id: moved.id },
      });

      await patch(manager, moved.id, {
        version: row.version,
        role: StaffRole.STOREKEEPER,
      }).expect(200);
      expect(await devices(moved.id)).toBe(0);

      // The access token outlives the revocation by up to 15 minutes; the
      // session behind it does not, so no device is bound.
      await subscribe(moved, 401);
      expect(await devices(moved.id)).toBe(0);

      const leaving = await person(StaffRole.CASHIER);

      await subscribe(leaving, 204);
      await patch(owner, leaving.id, {
        version: (
          await prisma.staff.findUniqueOrThrow({ where: { id: leaving.id } })
        ).version,
        isActive: false,
      }).expect(200);
      expect(await devices(leaving.id)).toBe(0);
    });
  });

  describe('the list', () => {
    it('finds accounts by part of the name, email or number, for managers only', async () => {
      const tag = unique();
      const created = await create(manager, {
        name: `Findable ${tag}`,
        email: emailFor('findable'),
        role: StaffRole.KITCHEN,
      }).expect(201);
      const staffNo = (created.body as { staff: Account }).staff.staffNo;

      for (const q of [tag, tag.toUpperCase(), staffNo]) {
        const response = await request(server())
          .get('/api/v1/staff/people')
          .query({ q })
          .set(as(manager))
          .expect(200);
        const page = response.body as { data: Account[]; total: number };

        expect(page.total).toBe(1);
        expect(page.data[0].staffNo).toBe(staffNo);
      }

      const refused = await request(server())
        .get('/api/v1/staff/people')
        .set(as(cashier))
        .expect(403);
      expect(messageOf(refused)).toBe(ROLE_REFUSED_MESSAGE);
    });
  });

  describe('photographs (staff.photo)', () => {
    const upload = (by: Person, id: string, version: number, file: Buffer) =>
      request(server())
        .post(`/api/v1/staff/people/${id}/photo`)
        .set(as(by))
        .field('version', String(version))
        .attach('photo', file, 'face.jpg');

    const versionOf = async (id: string) =>
      (await prisma.staff.findUniqueOrThrow({ where: { id } })).version;

    it('lets a person replace their own photo, stored square at 320 pixels and signed on the way out', async () => {
      const self = await person(StaffRole.WAITER);

      const response = await upload(
        self,
        self.id,
        await versionOf(self.id),
        await testImage(1200, 900),
      ).expect(200);
      const body = response.body as Account;

      expect(body.photoUrl).toMatch(/^https:\/\/storage\.test\/.+\/staff\//);

      const row = await prisma.staff.findUniqueOrThrow({
        where: { id: self.id },
      });
      expect(row.photo).toMatch(/^gs:\/\/[^/]+\/staff\//);

      const stored = storage.objectAt(row.photo!);
      const meta = await sharp(stored?.body).metadata();
      expect([meta.width, meta.height]).toEqual([320, 320]);
    });

    it('refuses someone else’s photo to a non-manager, and lets a manager change it', async () => {
      const other = await person(StaffRole.WAITER);

      const refused = await upload(
        cashier,
        other.id,
        await versionOf(other.id),
        await testImage(400, 400),
      ).expect(403);
      expect(messageOf(refused)).toBe(OWN_PHOTO_ONLY_MESSAGE);

      await upload(
        manager,
        other.id,
        await versionOf(other.id),
        await testImage(400, 400),
      ).expect(200);
    });

    it('deletes the replaced object, and the removed one', async () => {
      const self = await person(StaffRole.WAITER);

      await upload(
        self,
        self.id,
        await versionOf(self.id),
        await testImage(500, 500),
      ).expect(200);
      const first = (
        await prisma.staff.findUniqueOrThrow({ where: { id: self.id } })
      ).photo!;

      await upload(
        self,
        self.id,
        await versionOf(self.id),
        await testImage(600, 600, 'png'),
      ).expect(200);
      const second = (
        await prisma.staff.findUniqueOrThrow({ where: { id: self.id } })
      ).photo!;

      expect(second).not.toBe(first);
      expect(storage.objectAt(first)).toBeUndefined();
      expect(storage.objectAt(second)?.contentType).toBe('image/png');

      const removed = await request(server())
        .delete(`/api/v1/staff/people/${self.id}/photo`)
        .set(as(self))
        .send({ version: await versionOf(self.id) })
        .expect(200);

      expect((removed.body as Account).photoUrl).toBeNull();
      expect(storage.objectAt(second)).toBeUndefined();
    });

    it('leaves no object behind when the version is stale', async () => {
      const self = await person(StaffRole.WAITER);
      const before = storage.objects.size;

      const stale = await upload(
        self,
        self.id,
        (await versionOf(self.id)) + 5,
        await testImage(300, 300),
      ).expect(409);

      expect(messageOf(stale)).toBe(STALE_VERSION_MESSAGE);
      expect(storage.objects.size).toBe(before);
    });

    it('refuses no file, a document renamed .jpg, and a file over 5MB', async () => {
      const self = await person(StaffRole.WAITER);
      const version = await versionOf(self.id);

      const none = await request(server())
        .post(`/api/v1/staff/people/${self.id}/photo`)
        .set(as(self))
        .field('version', String(version))
        .expect(400);
      expect(messageOf(none)).toBe(PHOTO_MISSING_MESSAGE);

      const renamed = await upload(
        self,
        self.id,
        version,
        Buffer.from('%PDF-1.7 not a photo at all'),
      ).expect(415);
      expect(messageOf(renamed)).toBe(PHOTO_UNSUPPORTED_MESSAGE);

      const large = await upload(
        self,
        self.id,
        version,
        Buffer.alloc(5 * 1024 * 1024 + 1024, 1),
      ).expect(413);
      expect(messageOf(large)).toBe(PHOTO_TOO_LARGE_MESSAGE);

      expect(await versionOf(self.id)).toBe(version);
    });
  });

  describe('reissuing a staff ID', () => {
    const reissue = (by: Person, id: string, version: number) =>
      request(server())
        .post(`/api/v1/staff/people/${id}/qr/regenerate`)
        .set(as(by))
        .send({ version });

    it('replaces the token, keeps the number, and never returns the token', async () => {
      const account = await hire(StaffRole.KITCHEN);
      const before = await prisma.staff.findUniqueOrThrow({
        where: { id: account.id },
      });

      const response = await reissue(
        manager,
        account.id,
        before.version,
      ).expect(200);
      const after = await prisma.staff.findUniqueOrThrow({
        where: { id: account.id },
      });

      expect(after.qrToken).not.toBe(before.qrToken);
      expect(after.staffNo).toBe(before.staffNo);
      expect((response.body as Account).qrRegeneratedAt).toBe(
        after.qrRegeneratedAt?.toISOString(),
      );
      expect(JSON.stringify(response.body)).not.toContain(after.qrToken);

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { ref: before.staffNo, action: 'staff.regenerateQr' },
      });
      expect(JSON.stringify(entry)).not.toContain(after.qrToken);
      expect(JSON.stringify(entry)).not.toContain(before.qrToken);
    });

    it('keeps a Manager’s ID for the Owner, and refuses everyone but managers', async () => {
      const managerAccount = await hire(StaffRole.MANAGER);

      const refused = await reissue(
        manager,
        managerAccount.id,
        managerAccount.version,
      ).expect(403);
      expect(messageOf(refused)).toBe(OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE);

      await reissue(owner, managerAccount.id, managerAccount.version).expect(
        200,
      );

      const notManager = await reissue(cashier, cashier.id, 0).expect(403);
      expect(messageOf(notManager)).toBe(ROLE_REFUSED_MESSAGE);
    });
  });

  it('shows the history of an account in plain sentences', async () => {
    const account = await hire(StaffRole.WAITER);
    await patch(owner, account.id, {
      version: account.version,
      role: StaffRole.CASHIER,
    }).expect(200);

    const response = await request(server())
      .get('/api/v1/staff/audit')
      .query({ ref: account.staffNo })
      .set(as(owner))
      .expect(200);
    const rows = (
      response.body as {
        data: { actionLabel: string; changes: string[] }[];
      }
    ).data;

    expect(rows[0]).toMatchObject({
      actionLabel: 'Staff Record Saved',
      changes: ['Role changed from Waiter to Cashier.'],
    });
  });
});
