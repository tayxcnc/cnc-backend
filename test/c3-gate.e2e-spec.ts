import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { Department, StaffRole } from '../generated/cnc-client';
import { seedData } from '../prisma/data-seed';
import { seedOwner } from '../prisma/owner-seed';
import { INVALID_REFRESH_TOKEN_MESSAGE } from '../src/auth/cnc-token.service';
import {
  PASSWORD_CHANGE_REQUIRED_MESSAGE,
  STAFF_DEACTIVATED_MESSAGE,
} from '../src/auth/guards/cnc-staff.guard';
import { STAFF_REFRESH_COOKIE } from '../src/auth/refresh-cookie';
import { INVALID_CREDENTIALS_MESSAGE } from '../src/auth/staff-auth.service';
import {
  LAST_ACTIVE_OWNER_MESSAGE,
  OWNER_ONLY_PRICE_MESSAGE,
} from '../src/money-control/money-control.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp } from './create-test-app';
import {
  type IsolatedDatabase,
  createIsolatedDatabase,
} from './isolated-database';
import {
  clientAddress,
  staffRefreshCookieLine,
  staffRefreshCookieOf,
} from './staff-sessions';

/**
 * The founder's C3 gate (plan §15, C3), steps 1 to 7, walked against the API
 * in order, as the staff app will drive it.
 *
 * It runs on a database of its own (`createIsolatedDatabase`), seeded with
 * both real seeds: the reference data and menu, then the first Owner with a
 * temporary password. That makes the seeded Owner the only Owner, which
 * step 6 needs and the shared test database can never offer, and it makes
 * step 1 the seed's own temporary password rather than a fixture's.
 *
 * The steps share state and must run in order; each is one test so a
 * failure names its step. Jest runs a file's tests in order.
 */
describe('the C3 gate (e2e)', () => {
  let database: IsolatedDatabase | undefined;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  const originalUrl = process.env.CNC_DB_URL;

  const OWNER_EMAIL = 'owner@cnc.test';
  const TEMPORARY_PASSWORD = 'seeded-temporary-password';

  interface Session {
    id: string;
    accessToken: string;
    cookie: string;
    password: string;
    email: string;
  }

  interface Created {
    staff: { id: string; email: string; version: number };
    temporaryPassword: string;
  }

  interface MenuRow {
    id: string;
    priceKobo: number;
    description: string;
    version: number;
  }

  interface AuditRow {
    staffId: string | null;
    actorName: string;
    action: string;
  }

  let owner: Session;
  let managerA: Session;
  let managerB: Session;
  let cashier: Session;
  let managerBId: string;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env.CNC_DB_URL = database.url;

    app = await createTestApp();
    prisma = app.get(CncPrismaService);

    await seedData(prisma);
    await seedOwner(prisma, {
      email: OWNER_EMAIL,
      password: TEMPORARY_PASSWORD,
      name: 'Gate Owner',
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();

    if (originalUrl === undefined) delete process.env.CNC_DB_URL;
    else process.env.CNC_DB_URL = originalUrl;

    await database?.drop();
  });

  const server = () => app.getHttpServer();
  const bearer = (session: Session) => ({
    Authorization: `Bearer ${session.accessToken}`,
  });
  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  const signInCall = (email: string, password: string) =>
    request(server())
      .post('/api/v1/auth/staff/sign-in')
      .set('X-Forwarded-For', clientAddress())
      .send({ email, password });

  const refreshCall = (cookie: string) =>
    request(server())
      .post('/api/v1/auth/staff/refresh')
      .set('X-Forwarded-For', clientAddress())
      .set('Cookie', `${STAFF_REFRESH_COOKIE}=${cookie}`)
      .set('Content-Type', 'application/json')
      .send({});

  /** Sign in with the temporary password, then change it, as a new hire would. */
  async function firstSignIn(
    email: string,
    temporaryPassword: string,
  ): Promise<Session> {
    const signedIn = await signInCall(email, temporaryPassword).expect(200);
    const first = signedIn.body as {
      accessToken: string;
      staff: { id: string; mustChangePassword: boolean };
    };

    expect(first.staff.mustChangePassword).toBe(true);

    const password = `${temporaryPassword}-changed`;
    const changed = await request(server())
      .post('/api/v1/auth/staff/change-password')
      .set('X-Forwarded-For', clientAddress())
      .set('Authorization', `Bearer ${first.accessToken}`)
      .send({ currentPassword: temporaryPassword, newPassword: password })
      .expect(200);
    const body = changed.body as {
      accessToken: string;
      staff: { mustChangePassword: boolean };
    };

    expect(body.staff.mustChangePassword).toBe(false);

    return {
      id: first.staff.id,
      accessToken: body.accessToken,
      cookie: staffRefreshCookieOf(changed),
      password,
      email,
    };
  }

  async function hire(name: string, role: StaffRole): Promise<Created> {
    const response = await request(server())
      .post('/api/v1/staff/people')
      .set(bearer(owner))
      .send({
        name,
        email: `${role.toLowerCase()}.${name.at(-1)}@cnc.test`,
        role,
      })
      .expect(201);

    return response.body as Created;
  }

  async function restaurantItems(by: Session): Promise<MenuRow[]> {
    const response = await request(server())
      .get('/api/v1/staff/menu')
      .query({ department: Department.RESTAURANT, pageSize: 10 })
      .set(bearer(by))
      .expect(200);

    return (response.body as { data: MenuRow[] }).data;
  }

  const patchItem = (by: Session, id: string, body: object) =>
    request(server())
      .patch(`/api/v1/staff/menu/${id}`)
      .set(bearer(by))
      .send(body);

  async function activity(by: Session): Promise<AuditRow[]> {
    const response = await request(server())
      .get('/api/v1/staff/audit')
      .query({ pageSize: 100 })
      .set(bearer(by))
      .expect(200);
    const page = response.body as { data: AuditRow[]; total: number };

    // The whole history fits one page on this database.
    expect(page.total).toBe(page.data.length);

    return page.data;
  }

  async function versionOf(by: Session, email: string): Promise<number> {
    const response = await request(server())
      .get('/api/v1/staff/people')
      .query({ q: email })
      .set(bearer(by))
      .expect(200);
    const [row] = (
      response.body as { data: { email: string; version: number }[] }
    ).data.filter((person) => person.email === email);

    return row.version;
  }

  it('1. the Owner signs in and changes the temporary password', async () => {
    const signedIn = await signInCall(OWNER_EMAIL, TEMPORARY_PASSWORD).expect(
      200,
    );
    const body = signedIn.body as {
      accessToken: string;
      staff: { role: StaffRole; mustChangePassword: boolean };
    };

    expect(body.staff).toMatchObject({
      role: StaffRole.OWNER,
      mustChangePassword: true,
    });

    // Until the password changes, the app can learn who is signed in and
    // nothing else.
    await request(server())
      .get('/api/v1/staff/me')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);
    const blocked = await request(server())
      .get('/api/v1/staff/people')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(403);
    expect(messageOf(blocked)).toBe(PASSWORD_CHANGE_REQUIRED_MESSAGE);

    owner = await firstSignIn(OWNER_EMAIL, TEMPORARY_PASSWORD);

    await request(server())
      .get('/api/v1/staff/people')
      .set(bearer(owner))
      .expect(200);

    // The temporary password no longer works.
    const stale = await signInCall(OWNER_EMAIL, TEMPORARY_PASSWORD).expect(401);
    expect(messageOf(stale)).toBe(INVALID_CREDENTIALS_MESSAGE);
  });

  it('2. the Owner creates Managers A and B and a Cashier', async () => {
    const a = await hire('Manager A', StaffRole.MANAGER);
    const b = await hire('Manager B', StaffRole.MANAGER);
    const c = await hire('Cashier C', StaffRole.CASHIER);

    managerBId = b.staff.id;

    managerA = await firstSignIn(a.staff.email, a.temporaryPassword);
    managerB = await firstSignIn(b.staff.email, b.temporaryPassword);
    cashier = await firstSignIn(c.staff.email, c.temporaryPassword);

    const roles = await prisma.staff.findMany({
      where: { id: { in: [a.staff.id, b.staff.id, c.staff.id] } },
      select: { role: true },
    });
    expect(roles.map((row) => row.role).sort()).toEqual([
      StaffRole.CASHIER,
      StaffRole.MANAGER,
      StaffRole.MANAGER,
    ]);
  });

  it('3. Manager A cannot change a price, and can change a description', async () => {
    const [item] = await restaurantItems(managerA);

    const refused = await patchItem(managerA, item.id, {
      version: item.version,
      priceKobo: item.priceKobo + 10_000,
    }).expect(403);
    expect(messageOf(refused)).toBe('Only the Owner can change a price.');
    expect(OWNER_ONLY_PRICE_MESSAGE).toBe('Only the Owner can change a price.');

    const saved = await patchItem(managerA, item.id, {
      version: item.version,
      description: 'Gate step 3: a description from Manager A.',
    }).expect(200);
    expect(saved.body).toMatchObject({
      description: 'Gate step 3: a description from Manager A.',
      priceKobo: item.priceKobo,
    });
  });

  it('4. Activity History hides Manager B’s entries from Manager A, and the Owner sees all', async () => {
    const [, item] = await restaurantItems(managerB);

    await patchItem(managerB, item.id, {
      version: item.version,
      description: 'Gate step 4: a description from Manager B.',
    }).expect(200);

    const asManagerA = await activity(managerA);
    const seenByA = new Set(asManagerA.map((row) => row.staffId));

    expect(seenByA.has(owner.id)).toBe(true);
    expect(seenByA.has(cashier.id)).toBe(true);
    expect(seenByA.has(managerA.id)).toBe(true);
    expect(seenByA.has(managerB.id)).toBe(false);

    const asOwner = await activity(owner);
    const bEntries = asOwner.filter((row) => row.staffId === managerB.id);

    expect(bEntries.map((row) => row.action)).toEqual(
      expect.arrayContaining(['menu.save', 'staff.changePassword']),
    );
    expect(new Set(asOwner.map((row) => row.staffId))).toEqual(
      new Set([owner.id, managerA.id, managerB.id, cashier.id]),
    );
  });

  it('5. the Owner deactivates Manager B, whose next action is refused', async () => {
    await request(server())
      .patch(`/api/v1/staff/people/${managerBId}`)
      .set(bearer(owner))
      .send({
        version: await versionOf(owner, managerB.email),
        isActive: false,
      })
      .expect(200);

    const [item] = await restaurantItems(owner);
    const refused = await patchItem(managerB, item.id, {
      version: item.version,
      description: 'Manager B after deactivation.',
    }).expect(403);
    expect(messageOf(refused)).toBe(STAFF_DEACTIVATED_MESSAGE);
    expect(String(messageOf(refused))).toMatch(
      /^This staff account has been deactivated/,
    );

    // Reloading lands on the sign-in screen: the session cannot be renewed,
    // and the password no longer signs in.
    const renewed = await refreshCall(managerB.cookie).expect(401);
    expect(messageOf(renewed)).toBe(INVALID_REFRESH_TOKEN_MESSAGE);
    await signInCall(managerB.email, managerB.password).expect(401);
  });

  it('6. the only Owner cannot demote or deactivate themselves', async () => {
    const version = await versionOf(owner, OWNER_EMAIL);

    for (const change of [{ role: StaffRole.MANAGER }, { isActive: false }]) {
      const refused = await request(server())
        .patch(`/api/v1/staff/people/${owner.id}`)
        .set(bearer(owner))
        .send({ version, ...change })
        .expect(403);

      expect(messageOf(refused)).toBe('CNC needs at least one active Owner.');
      expect(LAST_ACTIVE_OWNER_MESSAGE).toBe(
        'CNC needs at least one active Owner.',
      );
    }

    await expect(
      prisma.staff.findUniqueOrThrow({
        where: { id: owner.id },
        select: { role: true, isActive: true },
      }),
    ).resolves.toEqual({ role: StaffRole.OWNER, isActive: true });
  });

  it('7. a reload keeps the Owner signed in through the refresh cookie', async () => {
    const renewed = await refreshCall(owner.cookie).expect(200);
    const body = renewed.body as { accessToken: string };
    const line = staffRefreshCookieLine(renewed) ?? '';

    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/Path=\/api\/v1\/auth/);

    const me = await request(server())
      .get('/api/v1/staff/me')
      .set('Authorization', `Bearer ${body.accessToken}`)
      .expect(200);
    expect(me.body).toMatchObject({
      id: owner.id,
      role: StaffRole.OWNER,
      mustChangePassword: false,
    });

    // The cookie is single-use: the old one is spent, the new one works.
    await refreshCall(owner.cookie).expect(401);
    await refreshCall(staffRefreshCookieOf(renewed)).expect(200);
  });
});
