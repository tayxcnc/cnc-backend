import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { StaffRole } from '../generated/cnc-client';
import { TOO_MANY_ATTEMPTS_MESSAGE } from '../src/auth/auth-throttle';
import { INVALID_REFRESH_TOKEN_MESSAGE } from '../src/auth/cnc-token.service';
import {
  ACCOUNT_GONE_MESSAGE,
  CUSTOMER_TOKEN_ON_STAFF_ROUTE_MESSAGE,
  PASSWORD_CHANGE_REQUIRED_MESSAGE,
  STAFF_DEACTIVATED_MESSAGE,
} from '../src/auth/guards/cnc-staff.guard';
import { hashPassword, verifyPassword } from '../src/auth/password';
import {
  NO_STAFF_REFRESH_COOKIE_MESSAGE,
  REFRESH_NEEDS_JSON_MESSAGE,
} from '../src/auth/staff-auth.controller';
import {
  CURRENT_PASSWORD_INCORRECT_MESSAGE,
  INVALID_CREDENTIALS_MESSAGE,
  OWN_PASSWORD_RESET_MESSAGE,
  OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE,
  SAME_PASSWORD_MESSAGE,
  STAFF_NOT_FOUND_MESSAGE,
} from '../src/auth/staff-auth.service';
import { ROLE_REFUSED_MESSAGE } from '../src/auth/staff-roles';
import { StructuredLogger } from '../src/common/logging/structured-logger';
import { generateQrToken } from '../src/common/qr-token';
import { watToday } from '../src/common/wat';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { drawNumber } from '../src/prisma/sequences';
import { createTestApp } from './create-test-app';

/**
 * Staff sign-in, refresh, sign-out, change-password and the admin reset
 * (C3-3), with the guard's role, deactivation and forced-change rules, the
 * throttles, and TAY's cookies, through HTTP and against Postgres.
 *
 * Every account is run-unique and nothing is removed. Every throttled call
 * comes from its own address (`X-Forwarded-For`), so tests never share a
 * rate-limit bucket except where a test means to.
 */
describe('staff auth (e2e)', () => {
  const ALLOWED = 'https://staff.allowed.example';
  const originalOrigins = process.env.CNC_CORS_ORIGINS;
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let jwt: JwtService;

  beforeAll(async () => {
    process.env.CNC_CORS_ORIGINS = ALLOWED;
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    jwt = app.get(JwtService, { strict: false });
  });

  afterAll(async () => {
    await app.close();
    if (originalOrigins === undefined) delete process.env.CNC_CORS_ORIGINS;
    else process.env.CNC_CORS_ORIGINS = originalOrigins;
  });

  const server = () => app.getHttpServer();

  /**
   * A fresh client address, as Cloud Run's front end would forward it: the
   * caller, then the front end. `clientAddressOf` takes the caller.
   */
  const address = () => `10.${[...randomBytes(3)].join('.')}, 10.255.255.1`;

  interface Account {
    id: string;
    email: string;
    password: string;
  }

  /** A run-unique staff account with a known password. */
  async function createStaff(
    role: StaffRole,
    options: { isActive?: boolean; mustChangePassword?: boolean } = {},
  ): Promise<Account> {
    const email = `auth-${randomUUID()}@cnc.test`;
    const password = `pw-${randomUUID()}`;

    const staff = await prisma.staff.create({
      data: {
        staffNo: await drawNumber(prisma, 'staff'),
        name: `Auth ${role.toLowerCase()}`,
        email,
        role,
        isActive: options.isActive ?? true,
        passwordHash: await hashPassword(password),
        mustChangePassword: options.mustChangePassword ?? false,
        qrToken: generateQrToken(),
        joinedOn: watToday(new Date()),
      },
      select: { id: true },
    });

    return { id: staff.id, email, password };
  }

  const signInCall = (email: string, password: string, from = address()) =>
    request(server())
      .post('/api/v1/auth/staff/sign-in')
      .set('X-Forwarded-For', from)
      .send({ email, password });

  /** The value of the staff refresh cookie a response set, if any. */
  function setCookieLine(response: request.Response): string | undefined {
    const lines = response.headers['set-cookie'] as unknown as
      string[] | undefined;

    return lines?.find((line) => line.startsWith('cnc_staff_refresh_token='));
  }

  function refreshCookieOf(response: request.Response): string {
    const line = setCookieLine(response);
    if (line === undefined) throw new Error('No staff refresh cookie was set.');

    return line.split(';')[0].slice('cnc_staff_refresh_token='.length);
  }

  interface Session {
    accessToken: string;
    cookie: string;
  }

  async function signIn(account: Account): Promise<Session> {
    const response = await signInCall(account.email, account.password).expect(
      200,
    );
    const body = response.body as { accessToken: string };

    return { accessToken: body.accessToken, cookie: refreshCookieOf(response) };
  }

  const refreshCall = (cookie: string, from = address()) =>
    request(server())
      .post('/api/v1/auth/staff/refresh')
      .set('X-Forwarded-For', from)
      .set('Cookie', `cnc_staff_refresh_token=${cookie}`)
      .set('Content-Type', 'application/json')
      .send({});

  const signOutCall = (accessToken: string) =>
    request(server())
      .post('/api/v1/auth/staff/sign-out')
      .set('Authorization', `Bearer ${accessToken}`);

  const changePasswordCall = (
    accessToken: string,
    body: Record<string, unknown>,
    from = address(),
  ) =>
    request(server())
      .post('/api/v1/auth/staff/change-password')
      .set('X-Forwarded-For', from)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);

  const resetCall = (accessToken: string, targetId: string, from = address()) =>
    request(server())
      .post(`/api/v1/staff/people/${targetId}/reset-password`)
      .set('X-Forwarded-For', from)
      .set('Authorization', `Bearer ${accessToken}`)
      .send();

  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  describe('sign-in', () => {
    it('signs in by email and password, sets the cookie, and returns the summary', async () => {
      const account = await createStaff(StaffRole.CASHIER);

      const response = await signInCall(
        `  ${account.email.toUpperCase()} `,
        account.password,
      ).expect(200);

      const body = response.body as {
        accessToken: string;
        staff: Record<string, unknown>;
      };
      expect(typeof body.accessToken).toBe('string');
      expect(Object.keys(body.staff).sort()).toEqual([
        'email',
        'id',
        'mustChangePassword',
        'name',
        'role',
        'staffNo',
      ]);
      expect(body.staff).toMatchObject({
        id: account.id,
        email: account.email,
        role: 'CASHIER',
        mustChangePassword: false,
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /passwordHash|qrToken|refreshToken/,
      );

      // Host-only (no Domain), Lax, httpOnly, the auth path only, and as
      // long-lived as the row it names. Not Secure: this is not a built
      // container (NODE_ENV is not production).
      const attributes = setCookieLine(response)!
        .split(';')
        .slice(1)
        .map((part) => part.trim().toLowerCase());
      expect(attributes).toEqual(
        expect.arrayContaining([
          'max-age=604800',
          'path=/api/v1/auth',
          'httponly',
          'samesite=lax',
        ]),
      );
      expect(attributes.some((part) => part.startsWith('domain'))).toBe(false);
      expect(attributes).not.toContain('secure');

      // The token carries who, never a role (A14).
      const claims = jwt.decode<Record<string, unknown>>(body.accessToken);
      expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'sub', 'type']);
      expect(claims).toMatchObject({ sub: account.id, type: 'STAFF' });
      expect((claims.exp as number) - (claims.iat as number)).toBe(15 * 60);
    });

    it('answers a wrong password, an unknown email and a deactivated account identically', async () => {
      const account = await createStaff(StaffRole.WAITER);
      const inactive = await createStaff(StaffRole.WAITER, { isActive: false });

      const responses = [
        await signInCall(account.email, `${account.password}x`),
        await signInCall(`nobody-${randomUUID()}@cnc.test`, account.password),
        await signInCall(inactive.email, inactive.password),
      ];

      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(messageOf(response)).toBe(INVALID_CREDENTIALS_MESSAGE);
        expect(setCookieLine(response)).toBeUndefined();
      }
      const shapes = responses.map((response) => {
        const { requestId, ...rest } = response.body as Record<string, unknown>;
        expect(typeof requestId).toBe('string');
        return rest;
      });
      expect(shapes[1]).toEqual(shapes[0]);
      expect(shapes[2]).toEqual(shapes[0]);
    });

    it('refuses a body that is not an email and a password with a 400', async () => {
      const response = await request(server())
        .post('/api/v1/auth/staff/sign-in')
        .set('X-Forwarded-For', address())
        .send({ email: 'not-an-email', password: '' })
        .expect(400);

      expect(messageOf(response)).toEqual(
        expect.arrayContaining(['email must be a valid email address.']),
      );
    });

    it('allows ten attempts per address in the window, then answers 429', async () => {
      const account = await createStaff(StaffRole.KITCHEN);
      const from = address();

      for (let attempt = 1; attempt <= 10; attempt++) {
        await signInCall(account.email, 'wrong-password', from).expect(401);
      }

      const refused = await signInCall(account.email, account.password, from);
      expect(refused.status).toBe(429);
      expect(messageOf(refused)).toBe(TOO_MANY_ATTEMPTS_MESSAGE);

      // Another address has its own count, and the right password works.
      await signInCall(account.email, account.password, address()).expect(200);
    });
  });

  describe('refresh', () => {
    it('rotates: each cookie works once, and its replacement works', async () => {
      const account = await createStaff(StaffRole.RECEPTION);
      const first = await signIn(account);

      const rotated = await refreshCall(first.cookie).expect(200);
      const second = refreshCookieOf(rotated);
      expect(second).not.toBe(first.cookie);
      expect((rotated.body as { staff: { id: string } }).staff.id).toBe(
        account.id,
      );

      const replayed = await refreshCall(first.cookie).expect(401);
      expect(messageOf(replayed)).toBe(INVALID_REFRESH_TOKEN_MESSAGE);

      await refreshCall(second).expect(200);
    });

    it('lets exactly one of two simultaneous refreshes with one cookie through', async () => {
      const account = await createStaff(StaffRole.RECEPTION);
      const { cookie } = await signIn(account);

      const statuses = (
        await Promise.all([refreshCall(cookie), refreshCall(cookie)])
      )
        .map((response) => response.status)
        .sort();

      expect(statuses).toEqual([200, 401]);
    });

    it('refuses a deactivated account’s refresh', async () => {
      const account = await createStaff(StaffRole.CASHIER);
      const { cookie } = await signIn(account);

      // Deactivated without revoking anything, so the refresh itself must
      // read the account.
      await prisma.staff.update({
        where: { id: account.id },
        data: { isActive: false },
      });

      const response = await refreshCall(cookie).expect(401);
      expect(messageOf(response)).toBe(INVALID_REFRESH_TOKEN_MESSAGE);
      expect(setCookieLine(response)).toBeUndefined();
    });

    it('needs JSON, and a refused content type does not spend the token', async () => {
      const account = await createStaff(StaffRole.CASHIER);
      const { cookie } = await signIn(account);

      const refused = await request(server())
        .post('/api/v1/auth/staff/refresh')
        .set('X-Forwarded-For', address())
        .set('Cookie', `cnc_staff_refresh_token=${cookie}`)
        .set('Content-Type', 'text/plain')
        .send('{}')
        .expect(403);
      expect(messageOf(refused)).toBe(REFRESH_NEEDS_JSON_MESSAGE);

      await refreshCall(cookie).expect(200);
    });

    it('answers 400 with no staff cookie, and an unknown token 401', async () => {
      const missing = await request(server())
        .post('/api/v1/auth/staff/refresh')
        .set('X-Forwarded-For', address())
        .set('Content-Type', 'application/json')
        .send({})
        .expect(400);
      expect(messageOf(missing)).toBe(NO_STAFF_REFRESH_COOKIE_MESSAGE);

      const unknown = await refreshCall(randomBytes(32).toString('base64url'));
      expect(unknown.status).toBe(401);
      expect(messageOf(unknown)).toBe(INVALID_REFRESH_TOKEN_MESSAGE);
    });

    it('can be preflighted from an allowed origin with a JSON body and credentials', async () => {
      const response = await request(server())
        .options('/api/v1/auth/staff/refresh')
        .set('Origin', ALLOWED)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');

      expect(response.status).toBeLessThan(300);
      expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });
  });

  describe('sign-out', () => {
    it('ends every session the account holds and clears the cookie', async () => {
      const account = await createStaff(StaffRole.BARTENDER);
      const here = await signIn(account);
      const elsewhere = await signIn(account);

      const response = await signOutCall(here.accessToken).expect(204);

      // The clear names the same path and attributes, with an expiry in the
      // past, so the browser drops the cookie.
      const line = setCookieLine(response)!;
      expect(line.startsWith('cnc_staff_refresh_token=;')).toBe(true);
      const attributes = line.toLowerCase();
      expect(attributes).toContain('path=/api/v1/auth');
      expect(attributes).toContain('samesite=lax');
      expect(attributes).toContain('httponly');
      expect(attributes).toContain('expires=thu, 01 jan 1970');
      expect(attributes).not.toContain('domain');

      await refreshCall(here.cookie).expect(401);
      await refreshCall(elsewhere.cookie).expect(401);
    });

    it('is open while a password change is pending', async () => {
      const account = await createStaff(StaffRole.CASHIER, {
        mustChangePassword: true,
      });
      const session = await signIn(account);

      await signOutCall(session.accessToken).expect(204);
      await refreshCall(session.cookie).expect(401);
    });

    it('needs a bearer token', async () => {
      await request(server()).post('/api/v1/auth/staff/sign-out').expect(401);
    });
  });

  describe('change-password', () => {
    it('changes the password, ends the old sessions and starts a new one', async () => {
      const account = await createStaff(StaffRole.STOREKEEPER, {
        mustChangePassword: true,
      });
      const before = await signIn(account);
      const newPassword = `new-${randomUUID()}`;

      const response = await changePasswordCall(before.accessToken, {
        currentPassword: account.password,
        newPassword,
      }).expect(200);

      const body = response.body as {
        accessToken: string;
        staff: { mustChangePassword: boolean };
      };
      expect(body.staff.mustChangePassword).toBe(false);
      const after = refreshCookieOf(response);

      // The old refresh token is gone; the new one works.
      await refreshCall(before.cookie).expect(401);
      await refreshCall(after).expect(200);

      // Only the new password signs in, and it is stored as argon2id.
      await signInCall(account.email, account.password).expect(401);
      await signInCall(account.email, newPassword).expect(200);
      const row = await prisma.staff.findUniqueOrThrow({
        where: { id: account.id },
        select: { passwordHash: true, mustChangePassword: true },
      });
      expect(row.mustChangePassword).toBe(false);
      expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
      await expect(verifyPassword(row.passwordHash, newPassword)).resolves.toBe(
        true,
      );
    });

    it('refuses a wrong current password, a short one, and the same one', async () => {
      const account = await createStaff(StaffRole.KITCHEN);
      const { accessToken } = await signIn(account);

      const wrong = await changePasswordCall(accessToken, {
        currentPassword: `${account.password}x`,
        newPassword: `new-${randomUUID()}`,
      }).expect(401);
      expect(messageOf(wrong)).toBe(CURRENT_PASSWORD_INCORRECT_MESSAGE);

      const short = await changePasswordCall(accessToken, {
        currentPassword: account.password,
        newPassword: 'seven77',
      }).expect(400);
      expect(messageOf(short)).toEqual(
        expect.arrayContaining(['newPassword must be at least 8 characters.']),
      );

      const same = await changePasswordCall(accessToken, {
        currentPassword: account.password,
        newPassword: account.password,
      }).expect(400);
      expect(messageOf(same)).toBe(SAME_PASSWORD_MESSAGE);

      // None of them changed anything.
      await signInCall(account.email, account.password).expect(200);
    });
  });

  describe('the guard', () => {
    it('refuses every route but the exempt ones while a password change is pending', async () => {
      const manager = await createStaff(StaffRole.MANAGER, {
        mustChangePassword: true,
      });
      const cashier = await createStaff(StaffRole.CASHIER);
      const first = await signIn(manager);

      const signedIn = await signInCall(manager.email, manager.password);
      expect(
        (signedIn.body as { staff: { mustChangePassword: boolean } }).staff
          .mustChangePassword,
      ).toBe(true);

      const blocked = await resetCall(first.accessToken, cashier.id).expect(
        403,
      );
      expect(messageOf(blocked)).toBe(PASSWORD_CHANGE_REQUIRED_MESSAGE);

      const changed = await changePasswordCall(first.accessToken, {
        currentPassword: manager.password,
        newPassword: `new-${randomUUID()}`,
      }).expect(200);

      // The token the change returned is not held back.
      await resetCall(
        (changed.body as { accessToken: string }).accessToken,
        cashier.id,
      ).expect(200);
    });

    it('refuses a deactivated account at once, with its own sentence', async () => {
      const manager = await createStaff(StaffRole.MANAGER);
      const cashier = await createStaff(StaffRole.CASHIER);
      const { accessToken } = await signIn(manager);

      await prisma.staff.update({
        where: { id: manager.id },
        data: { isActive: false },
      });

      for (const response of [
        await resetCall(accessToken, cashier.id),
        await signOutCall(accessToken),
        await changePasswordCall(accessToken, {
          currentPassword: manager.password,
          newPassword: `new-${randomUUID()}`,
        }),
      ]) {
        expect(response.status).toBe(403);
        expect(messageOf(response)).toBe(STAFF_DEACTIVATED_MESSAGE);
      }
      expect(
        STAFF_DEACTIVATED_MESSAGE.startsWith(
          'This staff account has been deactivated',
        ),
      ).toBe(true);
    });

    it('reads the role from the row on every request, not the token', async () => {
      const manager = await createStaff(StaffRole.MANAGER);
      const cashier = await createStaff(StaffRole.CASHIER);
      const { accessToken } = await signIn(manager);

      await prisma.staff.update({
        where: { id: manager.id },
        data: { role: StaffRole.WAITER },
      });

      const refused = await resetCall(accessToken, cashier.id).expect(403);
      expect(messageOf(refused)).toBe(ROLE_REFUSED_MESSAGE);
    });

    it('answers 401 to a token signed with another secret, an expired token, and a vanished account', async () => {
      const account = await createStaff(StaffRole.CASHIER);

      const foreign = await new JwtService({
        secret: randomBytes(32).toString('hex'),
      }).signAsync({ sub: account.id, type: 'STAFF' }, { expiresIn: '15m' });
      await signOutCall(foreign).expect(401);

      const expired = await jwt.signAsync(
        { sub: account.id, type: 'STAFF' },
        { expiresIn: -10 },
      );
      await signOutCall(expired).expect(401);

      const vanished = await jwt.signAsync(
        { sub: `gone-${randomUUID()}`, type: 'STAFF' },
        { expiresIn: '15m' },
      );
      const gone = await signOutCall(vanished).expect(401);
      expect(messageOf(gone)).toBe(ACCOUNT_GONE_MESSAGE);
    });

    it('answers 403, not 401, to a valid customer token', async () => {
      const customer = await jwt.signAsync(
        { sub: `customer-${randomUUID()}`, type: 'CUSTOMER' },
        { expiresIn: '15m' },
      );

      const response = await signOutCall(customer).expect(403);
      expect(messageOf(response)).toBe(CUSTOMER_TOKEN_ON_STAFF_ROUTE_MESSAGE);
    });
  });

  describe('the admin password reset', () => {
    it('lets a manager reset a staff account: new temporary password, old sessions ended', async () => {
      const manager = await createStaff(StaffRole.MANAGER);
      const cashier = await createStaff(StaffRole.CASHIER);
      const managerSession = await signIn(manager);
      const cashierSession = await signIn(cashier);

      const response = await resetCall(
        managerSession.accessToken,
        cashier.id,
      ).expect(200);
      const { temporaryPassword } = response.body as {
        temporaryPassword: string;
      };
      expect(Object.keys(response.body as object)).toEqual([
        'temporaryPassword',
      ]);
      expect(temporaryPassword).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){4}$/);

      // The cashier's sessions are over and the old password no longer works.
      await refreshCall(cashierSession.cookie).expect(401);
      const stale = await resetCall(
        cashierSession.accessToken,
        manager.id,
      ).expect(403);
      expect(messageOf(stale)).toBe(PASSWORD_CHANGE_REQUIRED_MESSAGE);
      await signInCall(cashier.email, cashier.password).expect(401);

      // The temporary password signs in, and must be changed.
      const signedIn = await signInCall(
        cashier.email,
        temporaryPassword,
      ).expect(200);
      expect(
        (signedIn.body as { staff: { mustChangePassword: boolean } }).staff
          .mustChangePassword,
      ).toBe(true);

      // The manager's own session is untouched.
      await refreshCall(managerSession.cookie).expect(200);
    });

    it('keeps Manager and Owner accounts to the Owner', async () => {
      const owner = await createStaff(StaffRole.OWNER);
      const manager = await createStaff(StaffRole.MANAGER);
      const otherManager = await createStaff(StaffRole.MANAGER);
      const ownerSession = await signIn(owner);
      const managerSession = await signIn(manager);

      for (const target of [otherManager.id, owner.id]) {
        const refused = await resetCall(
          managerSession.accessToken,
          target,
        ).expect(403);
        expect(messageOf(refused)).toBe(OWNER_ONLY_MANAGER_ACCOUNTS_MESSAGE);
      }
      // Refused means unchanged.
      await signInCall(otherManager.email, otherManager.password).expect(200);

      await resetCall(ownerSession.accessToken, otherManager.id).expect(200);
    });

    it('refuses other roles, one’s own account, and an unknown id', async () => {
      const cashier = await createStaff(StaffRole.CASHIER);
      const waiter = await createStaff(StaffRole.WAITER);
      const owner = await createStaff(StaffRole.OWNER);
      const cashierSession = await signIn(cashier);
      const ownerSession = await signIn(owner);

      const role = await resetCall(
        cashierSession.accessToken,
        waiter.id,
      ).expect(403);
      expect(messageOf(role)).toBe(ROLE_REFUSED_MESSAGE);

      const own = await resetCall(ownerSession.accessToken, owner.id).expect(
        403,
      );
      expect(messageOf(own)).toBe(OWN_PASSWORD_RESET_MESSAGE);

      const missing = await resetCall(
        ownerSession.accessToken,
        `missing-${randomUUID()}`,
      ).expect(404);
      expect(messageOf(missing)).toBe(STAFF_NOT_FOUND_MESSAGE);

      await signInCall(waiter.email, waiter.password).expect(200);
      await signInCall(owner.email, owner.password).expect(200);
    });

    it('needs a bearer token', async () => {
      await request(server())
        .post(`/api/v1/staff/people/${randomUUID()}/reset-password`)
        .set('X-Forwarded-For', address())
        .expect(401);
    });

    it('allows ten resets per address in the window, then answers 429', async () => {
      const manager = await createStaff(StaffRole.MANAGER);
      const cashier = await createStaff(StaffRole.CASHIER);
      const { accessToken } = await signIn(manager);
      const from = address();

      for (let attempt = 1; attempt <= 10; attempt++) {
        await resetCall(accessToken, cashier.id, from).expect(200);
      }

      const refused = await resetCall(accessToken, cashier.id, from);
      expect(refused.status).toBe(429);
      expect(messageOf(refused)).toBe(TOO_MANY_ATTEMPTS_MESSAGE);
    });
  });

  describe("TAY's cookies", () => {
    it('are never read, logged or returned', async () => {
      const account = await createStaff(StaffRole.CASHIER);
      const session = await signIn(account);
      const tayMember = `tay-member-${randomUUID()}`;
      const tayStaff = `tay-staff-${randomUUID()}`;
      const tayCookies =
        `tay_refresh_token=${tayMember}; ` +
        `tay_staff_refresh_token=${tayStaff}`;

      // The service's own JSON logger at every level, as on Cloud Run. The
      // testing module's logger drops everything below error, which would
      // make "nothing was logged" true by default.
      app.useLogger(new StructuredLogger(true));

      // Everything the process writes while the requests run.
      const written: string[] = [];
      const capture = (chunk: unknown): boolean => {
        written.push(String(chunk));
        return true;
      };
      const stdout = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(capture);
      const stderr = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(capture);

      let responses: request.Response[];
      try {
        responses = [
          // Only TAY's cookies: there is no staff cookie to refresh with.
          await request(server())
            .post('/api/v1/auth/staff/refresh')
            .set('X-Forwarded-For', address())
            .set('Cookie', tayCookies)
            .set('Content-Type', 'application/json')
            .send({}),
          // A real CNC token under TAY's name is not read either.
          await request(server())
            .post('/api/v1/auth/staff/refresh')
            .set('X-Forwarded-For', address())
            .set('Cookie', `tay_staff_refresh_token=${session.cookie}`)
            .set('Content-Type', 'application/json')
            .send({}),
          // Beside a real CNC cookie, TAY's are ignored and the CNC one works.
          await request(server())
            .post('/api/v1/auth/staff/refresh')
            .set('X-Forwarded-For', address())
            .set(
              'Cookie',
              `${tayCookies}; cnc_staff_refresh_token=${session.cookie}`,
            )
            .set('Content-Type', 'application/json')
            .send({}),
          // A failed sign-in for an unknown address, which is logged.
          await request(server())
            .post('/api/v1/auth/staff/sign-in')
            .set('X-Forwarded-For', address())
            .set('Cookie', tayCookies)
            .send({
              email: `nobody-${randomUUID()}@cnc.test`,
              password: 'whatever-it-is',
            }),
          // A refused staff route.
          await request(server())
            .post('/api/v1/auth/staff/sign-out')
            .set('Cookie', tayCookies),
          // A route that does not exist.
          await request(server())
            .get(`/api/v1/no-such-route-${randomUUID()}`)
            .set('Cookie', tayCookies),
        ];
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }

      expect(responses.map((response) => response.status)).toEqual([
        400, 400, 200, 401, 401, 404,
      ]);
      expect(messageOf(responses[0])).toBe(NO_STAFF_REFRESH_COOKIE_MESSAGE);
      expect(messageOf(responses[1])).toBe(NO_STAFF_REFRESH_COOKIE_MESSAGE);

      // The unknown-email sign-in did log, so the capture was live.
      expect(written.join('')).toContain('Staff sign-in failed');

      for (const secret of [tayMember, tayStaff]) {
        expect(written.join('')).not.toContain(secret);
        for (const response of responses) {
          expect(response.text ?? '').not.toContain(secret);
          expect(JSON.stringify(response.headers)).not.toContain(secret);
        }
      }
    });
  });
});
