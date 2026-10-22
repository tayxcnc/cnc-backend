/*
 * The messages sweep needs a token, read through CncConfigService from the
 * environment, so it is set before the app is built (as `sweeps.e2e-spec`
 * does). Jest gives each test file its own copy of process.env.
 */
const SWEEP_TOKEN = `sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`;

process.env.CNC_SWEEP_TOKEN = SWEEP_TOKEN;

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  OutboundMessageStatus,
  OtpPurpose,
  StaffRole,
  SubjectType,
} from '../generated/cnc-client';
import { TOO_MANY_ATTEMPTS_MESSAGE } from '../src/auth/auth-throttle';
import {
  CncTokenService,
  INVALID_REFRESH_TOKEN_MESSAGE,
} from '../src/auth/cnc-token.service';
import { STAFF_TOKEN_ON_CUSTOMER_ROUTE_MESSAGE } from '../src/auth/guards/cnc-customer.guard';
import { CUSTOMER_TOKEN_ON_STAFF_ROUTE_MESSAGE } from '../src/auth/guards/cnc-staff.guard';
import {
  CUSTOMER_REFRESH_COOKIE,
  STAFF_REFRESH_COOKIE,
} from '../src/auth/refresh-cookie';
import {
  NO_STAFF_REFRESH_COOKIE_MESSAGE,
  REFRESH_NEEDS_JSON_MESSAGE,
} from '../src/auth/staff-auth.controller';
import { StructuredLogger } from '../src/common/logging/structured-logger';
import { NO_REFRESH_COOKIE_MESSAGE } from '../src/customers/customer-auth.controller';
import {
  ENTER_CODE_MESSAGE,
  ENTER_EMAIL_MESSAGE,
} from '../src/customers/dto/customer-auth.dto';
import {
  ADD_YOUR_NAME_MESSAGE,
  NAME_TOO_LONG_MESSAGE,
} from '../src/customers/dto/update-me.request';
import { deriveKey } from '../src/common/derived-key';
import { CncConfigService } from '../src/config/cnc.config';
import {
  OTP_ADDRESS_LIMIT,
  OTP_CONTACT_LIMIT,
  OTP_DAILY_FAILED_LIMIT,
  OTP_HASH_KEY_INFO,
  OTP_MAX_ATTEMPTS,
  otpCodeHash,
} from '../src/customers/one-time-code';
import {
  ASK_FOR_NEW_CODE_MESSAGE,
  CODE_ATTEMPTS_SPENT_MESSAGE,
  CODE_EXPIRED_MESSAGE,
  wrongCodeMessage,
} from '../src/customers/otp.service';
import { SWEEP_TOKEN_HEADER } from '../src/internal/sweep-token.guard';
import { MAIL_NOT_CONFIGURED } from '../src/mail/outbound-messages.service';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp, sentMail } from './create-test-app';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';
import { clientAddress } from './staff-sessions';

interface ProfileBody {
  id: string;
  memberNo: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: unknown;
  prefs: {
    orderUpdates: boolean;
    bookingReminders: boolean;
    offers: boolean;
    channel: string;
  };
  photoUrl: string | null;
  createdAt: string;
  notificationsReadAt: string | null;
}

interface SignInBody {
  accessToken: string;
  customer: ProfileBody;
  isNew: boolean;
}

/** A run-unique customer email, upper-cased in part to prove normalising. */
const newEmail = () => `guest-${randomUUID()}@cnc.test`;

/**
 * The customer's email-code sign-in (C6-1, C6-2) through HTTP and against
 * Postgres: the code request and its caps, verification and its tries, the
 * first-time name, refresh, sign-out, the two realms kept apart, the
 * outbound queue (a send now, a wait while mail is not configured, the
 * retry sweep), and TAY's cookies ignored.
 *
 * Mail goes to the harness's `RecordingMailTransport`; a code is read from
 * the recorded email exactly as a customer reads it from their inbox.
 * Every call sends its own `X-Forwarded-For`, so no two tests share a cap
 * or a throttle unless one means to.
 */
describe('customer auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let tokens: CncTokenService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);
    tokens = app.get(CncTokenService);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  const messageOf = (response: request.Response) =>
    (response.body as { message: unknown }).message;

  const askCode = (email: unknown, from = clientAddress()) =>
    request(server())
      .post('/api/v1/auth/code')
      .set('X-Forwarded-For', from)
      .send({ email });

  const verifyCall = (email: unknown, code: unknown, from = clientAddress()) =>
    request(server())
      .post('/api/v1/auth/verify')
      .set('X-Forwarded-For', from)
      .send({ email, code });

  /** The code in the newest email to `email`, read as a person would. */
  const codeSentTo = (email: string): string => {
    const mail = sentMail(app).lastTo(email);
    const code = mail?.text.match(/\b(\d{6})\b/)?.[1];

    if (code === undefined) throw new Error(`No code was mailed to ${email}.`);

    return code;
  };

  /** A code as `OtpCode.codeHash` keeps it, under the service's key. */
  const keyedCodeHash = (code: string): string =>
    otpCodeHash(
      deriveKey(app.get(CncConfigService).jwtSecret, OTP_HASH_KEY_INFO),
      code,
    );

  /** A wrong code, certainly not the one sent. */
  const wrongCode = (email: string): string =>
    String((Number(codeSentTo(email)) + 1) % 1_000_000).padStart(6, '0');

  /** Let another code be asked for at once, as if 30 seconds had passed. */
  const skipResendGap = (email: string) =>
    prisma.otpCode.updateMany({
      where: { contact: email },
      data: { resendAfter: new Date(Date.now() - 1000) },
    });

  const refreshCookieLine = (response: request.Response) =>
    (response.headers['set-cookie'] as unknown as string[] | undefined)?.find(
      (line) => line.startsWith(`${CUSTOMER_REFRESH_COOKIE}=`),
    );

  const refreshCookieOf = (response: request.Response): string => {
    const line = refreshCookieLine(response);

    if (line === undefined) throw new Error('No customer cookie was set.');

    return line.split(';')[0].slice(`${CUSTOMER_REFRESH_COOKIE}=`.length);
  };

  const refreshCall = (cookie: string) =>
    request(server())
      .post('/api/v1/auth/refresh')
      .set('X-Forwarded-For', clientAddress())
      .set('Cookie', cookie)
      .set('Content-Type', 'application/json')
      .send({});

  /** Sign a new customer in through the routes. */
  const signIn = async (email = newEmail()) => {
    await askCode(email).expect(200);
    const response = await verifyCall(email, codeSentTo(email)).expect(200);

    return {
      email,
      body: response.body as SignInBody,
      cookie: refreshCookieOf(response),
    };
  };

  describe('POST /auth/code', () => {
    it('emails a six-digit code and answers without it', async () => {
      const email = newEmail();
      const response = await askCode(`  ${email.toUpperCase()} `).expect(200);

      expect(response.body).toEqual({
        sentTo: `g•••@cnc.test`,
        resendInSec: 30,
      });

      const mail = sentMail(app).lastTo(email);
      expect(mail).toBeDefined();
      const code = codeSentTo(email);
      expect(code).toMatch(/^\d{6}$/);
      expect(mail?.subject).toBe(`${code} is your CNC sign-in code`);
      expect(mail?.html).toContain('CHEF NORO CULINARY');
      expect(mail?.html).toContain(code);
      expect(response.text).not.toContain(code);

      // Stored as a digest; the queued email's payload is sealed and is
      // dropped once the email has gone.
      const row = await prisma.otpCode.findFirstOrThrow({
        where: { contact: email },
      });
      expect(row.purpose).toBe(OtpPurpose.SIGN_IN);
      // Keyed: a bare SHA-256 of six digits is reversed by trying them all.
      expect(row.codeHash).toBe(keyedCodeHash(code));
      expect(row.codeHash).not.toBe(CncTokenService.digest(code));
      expect(row.codeHash).not.toContain(code);
      // Ten minutes from the request (the row's createdAt is stamped by the
      // database, a few milliseconds apart from the server's clock).
      expect(
        Math.abs(
          row.expiresAt.getTime() - row.createdAt.getTime() - 10 * 60 * 1000,
        ),
      ).toBeLessThan(5000);

      const message = await prisma.outboundMessage.findUniqueOrThrow({
        where: { dedupeKey: `otp:${row.id}` },
      });
      expect(message).toMatchObject({
        to: email,
        template: 'customer.sign-in-code',
        status: OutboundMessageStatus.SENT,
        attempts: 1,
        payload: null,
        lastError: null,
      });
    });

    it('refuses anything but an email with the screen sentence', async () => {
      for (const email of ['', 'not-an-email', '08031234567', 42, null]) {
        const response = await askCode(email);
        expect(response.status).toBe(400);
        expect(messageOf(response)).toEqual([ENTER_EMAIL_MESSAGE]);
      }
    });

    it('waits 30 seconds between codes for one email', async () => {
      const email = newEmail();
      await askCode(email).expect(200);

      const again = await askCode(email);
      expect(again.status).toBe(429);
      expect(messageOf(again)).toMatch(
        /^Please wait ([1-9]|[12]\d|30) seconds before asking for a new code\.$/,
      );

      await skipResendGap(email);
      await askCode(email).expect(200);
    });

    it(`caps codes per email at ${OTP_CONTACT_LIMIT} in the window, from any address`, async () => {
      const email = newEmail();

      for (let sent = 0; sent < OTP_CONTACT_LIMIT; sent++) {
        await askCode(email).expect(200);
        await skipResendGap(email);
      }

      const refused = await askCode(email);
      expect(refused.status).toBe(429);
      expect(messageOf(refused)).toBe(TOO_MANY_ATTEMPTS_MESSAGE);
      expect(await prisma.otpCode.count({ where: { contact: email } })).toBe(
        OTP_CONTACT_LIMIT,
      );
    });

    it(`sends no new code once the email's codes took ${OTP_DAILY_FAILED_LIMIT} wrong tries in a day`, async () => {
      const email = newEmail();
      const rounds = OTP_DAILY_FAILED_LIMIT / OTP_MAX_ATTEMPTS;

      for (let round = 0; round < rounds; round++) {
        await askCode(email).expect(200);
        const wrong = wrongCode(email);

        for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt++) {
          await verifyCall(email, wrong).expect(400);
        }

        await skipResendGap(email);
      }

      // Out of the fifteen-minute window, still inside the day: only the
      // long cap refuses.
      const ageCodes = (ms: number) =>
        prisma.otpCode.updateMany({
          where: { contact: email },
          data: { createdAt: new Date(Date.now() - ms) },
        });

      await ageCodes(60 * 60 * 1000);
      const refused = await askCode(email);
      expect(refused.status).toBe(429);
      expect(messageOf(refused)).toBe(TOO_MANY_ATTEMPTS_MESSAGE);

      // A day later the tries have rolled out of the count.
      await ageCodes(25 * 60 * 60 * 1000);
      await askCode(email).expect(200);
    });

    it(`caps codes per address at ${OTP_ADDRESS_LIMIT} in the window, over every email`, async () => {
      const from = clientAddress();

      for (let sent = 0; sent < OTP_ADDRESS_LIMIT; sent++) {
        await askCode(newEmail(), from).expect(200);
      }

      const refused = await askCode(newEmail(), from);
      expect(refused.status).toBe(429);
      expect(messageOf(refused)).toBe(TOO_MANY_ATTEMPTS_MESSAGE);

      // Another address is not affected.
      await askCode(newEmail()).expect(200);
    });

    it('counts the caps once when two requests arrive together', async () => {
      const email = newEmail();
      const from = clientAddress();

      const answers = await Promise.all([
        askCode(email, from),
        askCode(email, from),
        askCode(email, from),
      ]);

      expect(answers.map((answer) => answer.status).sort()).toEqual([
        200, 429, 429,
      ]);
      expect(await prisma.otpCode.count({ where: { contact: email } })).toBe(1);
    });
  });

  describe('POST /auth/verify', () => {
    it('creates the account on first use, sets the cookie, and asks for a name', async () => {
      const email = newEmail();
      await askCode(email).expect(200);

      const response = await verifyCall(
        email.toUpperCase(),
        ` ${codeSentTo(email)} `,
      ).expect(200);
      const body = response.body as SignInBody;

      expect(body.isNew).toBe(true);
      expect(typeof body.accessToken).toBe('string');
      expect(body.customer).toMatchObject({
        name: '',
        email,
        phone: null,
        address: null,
        prefs: {
          orderUpdates: true,
          bookingReminders: true,
          offers: false,
          channel: 'EMAIL',
        },
        photoUrl: null,
        notificationsReadAt: null,
      });
      expect(body.customer.memberNo).toMatch(/^CNC-\d{6,}$/);
      expect(JSON.stringify(body)).not.toContain('refresh');

      const line = refreshCookieLine(response);
      expect(line).toMatch(/HttpOnly/i);
      expect(line).toMatch(/SameSite=Lax/i);
      expect(line).toMatch(/Path=\/api\/v1\/auth(;|$)/);
      expect(line).not.toMatch(/Domain=/i);
      expect(line).not.toContain(STAFF_REFRESH_COOKIE);

      const customer = await prisma.customer.findUniqueOrThrow({
        where: { email },
      });
      expect(customer.emailVerifiedAt).not.toBeNull();
      expect(customer.memberNo).toBe(body.customer.memberNo);

      const row = await prisma.otpCode.findFirstOrThrow({
        where: { contact: email },
      });
      expect(row.consumedAt).not.toBeNull();
      expect(row.customerId).toBe(customer.id);
    });

    it('saves the first-time name, and the next sign-in is not new', async () => {
      const first = await signIn();

      const blank = await request(server())
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${first.body.accessToken}`)
        .send({ name: '   ' });
      expect(blank.status).toBe(400);
      expect(messageOf(blank)).toEqual([ADD_YOUR_NAME_MESSAGE]);

      const long = await request(server())
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${first.body.accessToken}`)
        .send({ name: 'A'.repeat(81) });
      expect(long.status).toBe(400);
      expect(messageOf(long)).toEqual([NAME_TOO_LONG_MESSAGE]);

      const saved = await request(server())
        .patch('/api/v1/me')
        .set('Authorization', `Bearer ${first.body.accessToken}`)
        .send({ name: '  Ada Obi ' })
        .expect(200);
      expect((saved.body as ProfileBody).name).toBe('Ada Obi');

      const me = await request(server())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${first.body.accessToken}`)
        .expect(200);
      expect(me.body).toEqual(saved.body);

      await skipResendGap(first.email);
      const again = await signIn(first.email);
      expect(again.body.isNew).toBe(false);
      expect(again.body.customer.id).toBe(first.body.customer.id);
      expect(again.body.customer.memberNo).toBe(first.body.customer.memberNo);
      expect(
        await prisma.customer.count({ where: { email: first.email } }),
      ).toBe(1);
    });

    it('counts down the tries in the account app words, then spends the code', async () => {
      const email = newEmail();
      await askCode(email).expect(200);
      const wrong = wrongCode(email);

      for (let left = OTP_MAX_ATTEMPTS - 1; left >= 1; left--) {
        const response = await verifyCall(email, wrong);
        expect(response.status).toBe(400);
        expect(messageOf(response)).toBe(wrongCodeMessage(left));
      }

      expect(wrongCodeMessage(1)).toBe('That code is not right. 1 try left.');
      expect(wrongCodeMessage(4)).toBe('That code is not right. 4 tries left.');

      const last = await verifyCall(email, wrong);
      expect(last.status).toBe(400);
      expect(messageOf(last)).toBe(CODE_ATTEMPTS_SPENT_MESSAGE);

      // The right code no longer works either.
      const right = await verifyCall(email, codeSentTo(email));
      expect(right.status).toBe(400);
      expect(messageOf(right)).toBe(CODE_ATTEMPTS_SPENT_MESSAGE);
      expect(await prisma.customer.count({ where: { email } })).toBe(0);
    });

    it('refuses an expired code', async () => {
      const email = newEmail();
      await askCode(email).expect(200);
      await prisma.otpCode.updateMany({
        where: { contact: email },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await verifyCall(email, codeSentTo(email));
      expect(response.status).toBe(400);
      expect(messageOf(response)).toBe(CODE_EXPIRED_MESSAGE);
    });

    it('asks for a new code when none was sent, or the code was used', async () => {
      const none = await verifyCall(newEmail(), '123456');
      expect(none.status).toBe(400);
      expect(messageOf(none)).toBe(ASK_FOR_NEW_CODE_MESSAGE);

      const used = await signIn();
      const again = await verifyCall(used.email, codeSentTo(used.email));
      expect(again.status).toBe(400);
      expect(messageOf(again)).toBe(ASK_FOR_NEW_CODE_MESSAGE);
    });

    it('takes only the newest code: a new one replaces the old', async () => {
      const email = newEmail();
      await askCode(email).expect(200);
      const older = codeSentTo(email);
      await skipResendGap(email);
      await askCode(email).expect(200);
      const newer = codeSentTo(email);

      if (older !== newer) {
        const stale = await verifyCall(email, older);
        expect(stale.status).toBe(400);
        expect(messageOf(stale)).toBe(wrongCodeMessage(OTP_MAX_ATTEMPTS - 1));
      }

      await verifyCall(email, newer).expect(200);
    });

    it('refuses a code that is not six digits without spending a try', async () => {
      const email = newEmail();
      await askCode(email).expect(200);

      for (const code of ['1234', '1234567', 'abcdef', '', 123456]) {
        const response = await verifyCall(email, code);
        expect(response.status).toBe(400);
        expect(messageOf(response)).toEqual([ENTER_CODE_MESSAGE]);
      }

      const row = await prisma.otpCode.findFirstOrThrow({
        where: { contact: email },
      });
      expect(row.attempts).toBe(0);
    });

    it('lets one of two verifies of the same code win', async () => {
      const email = newEmail();
      await askCode(email).expect(200);
      const code = codeSentTo(email);

      const answers = await Promise.all([
        verifyCall(email, code),
        verifyCall(email, code),
      ]);

      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400]);
      const loser = answers.find((answer) => answer.status === 400);
      expect(messageOf(loser!)).toBe(ASK_FOR_NEW_CODE_MESSAGE);
      expect(await prisma.customer.count({ where: { email } })).toBe(1);
    });
  });

  describe('refresh and sign-out', () => {
    it('restores the session from the cookie and rotates it', async () => {
      const session = await signIn();

      const refreshed = await refreshCall(
        `${CUSTOMER_REFRESH_COOKIE}=${session.cookie}`,
      ).expect(200);
      const body = refreshed.body as {
        accessToken: string;
        customer: ProfileBody;
      };

      expect(body.customer.id).toBe(session.body.customer.id);
      expect(Object.keys(body).sort()).toEqual(['accessToken', 'customer']);
      const next = refreshCookieOf(refreshed);
      expect(next).not.toBe(session.cookie);

      await request(server())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);
    });

    it('refuses a refresh with no cookie, or without JSON', async () => {
      const session = await signIn();

      const none = await refreshCall('');
      expect(none.status).toBe(400);
      expect(messageOf(none)).toBe(NO_REFRESH_COOKIE_MESSAGE);

      const form = await request(server())
        .post('/api/v1/auth/refresh')
        .set('X-Forwarded-For', clientAddress())
        .set('Cookie', `${CUSTOMER_REFRESH_COOKIE}=${session.cookie}`)
        .set('Content-Type', 'text/plain')
        .send('{}');
      expect(form.status).toBe(403);
      expect(messageOf(form)).toBe(REFRESH_NEEDS_JSON_MESSAGE);

      // The refused request spent nothing.
      await refreshCall(`${CUSTOMER_REFRESH_COOKIE}=${session.cookie}`).expect(
        200,
      );
    });

    it('refuses the cookie name twice and spends neither', async () => {
      const session = await signIn();
      const planted = await signIn();

      const twice = await refreshCall(
        `${CUSTOMER_REFRESH_COOKIE}=${planted.cookie}; ` +
          `${CUSTOMER_REFRESH_COOKIE}=${session.cookie}`,
      );
      expect(twice.status).toBe(401);
      expect(messageOf(twice)).toBe(INVALID_REFRESH_TOKEN_MESSAGE);

      await refreshCall(`${CUSTOMER_REFRESH_COOKIE}=${session.cookie}`).expect(
        200,
      );
    });

    it('signs out on every device and clears the cookie', async () => {
      const session = await signIn();
      await skipResendGap(session.email);
      const other = await signIn(session.email);

      const response = await request(server())
        .post('/api/v1/auth/sign-out')
        .set('Authorization', `Bearer ${session.body.accessToken}`)
        .expect(204);

      const cleared = refreshCookieLine(response);
      expect(cleared).toBeDefined();
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(cleared).toMatch(/Path=\/api\/v1\/auth(;|$)/);

      for (const cookie of [session.cookie, other.cookie]) {
        const refused = await refreshCall(
          `${CUSTOMER_REFRESH_COOKIE}=${cookie}`,
        );
        expect(refused.status).toBe(401);
        expect(messageOf(refused)).toBe(INVALID_REFRESH_TOKEN_MESSAGE);
      }
    });
  });

  describe('the two realms', () => {
    it('keeps customer and staff tokens and cookies apart', async () => {
      const customer = await signIn();
      const staff = await createStaffAccount(prisma, StaffRole.CASHIER);
      const staffToken = await accessTokenFor(tokens, staff.id);

      // A customer token on a staff route, and a staff token on a customer
      // route: known callers in the wrong place.
      const onStaff = await request(server())
        .get('/api/v1/staff/me')
        .set('Authorization', `Bearer ${customer.body.accessToken}`);
      expect(onStaff.status).toBe(403);
      expect(messageOf(onStaff)).toBe(CUSTOMER_TOKEN_ON_STAFF_ROUTE_MESSAGE);

      for (const call of [
        request(server()).get('/api/v1/me'),
        request(server()).patch('/api/v1/me').send({ name: 'Staff' }),
        request(server()).post('/api/v1/auth/sign-out'),
      ]) {
        const response = await call.set(
          'Authorization',
          `Bearer ${staffToken}`,
        );
        expect(response.status).toBe(403);
        expect(messageOf(response)).toBe(STAFF_TOKEN_ON_CUSTOMER_ROUTE_MESSAGE);
      }

      // The customer cookie is not the staff cookie, and the customer's
      // token under the staff name is refused without being spent.
      const staffRoute = await request(server())
        .post('/api/v1/auth/staff/refresh')
        .set('X-Forwarded-For', clientAddress())
        .set('Cookie', `${CUSTOMER_REFRESH_COOKIE}=${customer.cookie}`)
        .set('Content-Type', 'application/json')
        .send({});
      expect(staffRoute.status).toBe(400);
      expect(messageOf(staffRoute)).toBe(NO_STAFF_REFRESH_COOKIE_MESSAGE);

      const underStaffName = await request(server())
        .post('/api/v1/auth/staff/refresh')
        .set('X-Forwarded-For', clientAddress())
        .set('Cookie', `${STAFF_REFRESH_COOKIE}=${customer.cookie}`)
        .set('Content-Type', 'application/json')
        .send({});
      expect(underStaffName.status).toBe(401);

      const staffPair = await tokens.issueTokenPair(
        staff.id,
        SubjectType.STAFF,
      );
      const staffOnCustomer = await refreshCall(
        `${CUSTOMER_REFRESH_COOKIE}=${staffPair.refreshToken}`,
      );
      expect(staffOnCustomer.status).toBe(401);
      expect(messageOf(staffOnCustomer)).toBe(INVALID_REFRESH_TOKEN_MESSAGE);

      // Neither refusal spent the other realm's token.
      await refreshCall(`${CUSTOMER_REFRESH_COOKIE}=${customer.cookie}`).expect(
        200,
      );
      await request(server())
        .post('/api/v1/auth/staff/refresh')
        .set('X-Forwarded-For', clientAddress())
        .set('Cookie', `${STAFF_REFRESH_COOKIE}=${staffPair.refreshToken}`)
        .set('Content-Type', 'application/json')
        .send({})
        .expect(200);
    });

    it('refuses a token whose customer is gone', async () => {
      const response = await request(server())
        .get('/api/v1/me')
        .set(
          'Authorization',
          `Bearer ${(await tokens.issueTokenPair(`gone-${randomUUID()}`, SubjectType.CUSTOMER)).accessToken}`,
        );

      expect(response.status).toBe(401);
    });
  });

  describe('the outbound queue', () => {
    const sweepMessages = () =>
      request(server())
        .post('/api/v1/internal/sweeps/messages')
        .set(SWEEP_TOKEN_HEADER, SWEEP_TOKEN)
        .send();

    afterEach(() => {
      sentMail(app).configured = true;
      sentMail(app).failWith = undefined;
    });

    it('keeps the email for the sweep while mail is not configured, and the request still succeeds', async () => {
      const email = newEmail();
      sentMail(app).configured = false;

      await askCode(email).expect(200);
      expect(sentMail(app).lastTo(email)).toBeUndefined();

      const row = await prisma.otpCode.findFirstOrThrow({
        where: { contact: email },
      });
      const waiting = await prisma.outboundMessage.findUniqueOrThrow({
        where: { dedupeKey: `otp:${row.id}` },
      });
      expect(waiting).toMatchObject({
        status: OutboundMessageStatus.PENDING,
        attempts: 0,
        lastError: MAIL_NOT_CONFIGURED,
      });
      // Sealed: the stored payload is not the code in any readable form.
      expect(waiting.payload).toMatch(/^v1\./);
      expect(waiting.expiresAt?.getTime()).toBe(row.expiresAt.getTime());

      sentMail(app).configured = true;
      const swept = await sweepMessages().expect(200);
      expect((swept.body as { sent: number }).sent).toBeGreaterThanOrEqual(1);

      const code = codeSentTo(email);
      expect(waiting.payload).not.toContain(code);
      expect(row.codeHash).toBe(keyedCodeHash(code));

      const sent = await prisma.outboundMessage.findUniqueOrThrow({
        where: { id: waiting.id },
      });
      expect(sent).toMatchObject({
        status: OutboundMessageStatus.SENT,
        attempts: 1,
        payload: null,
        lastError: null,
      });

      await verifyCall(email, code).expect(200);
    });

    it('records a failed send, retries it, and gives up an expired one', async () => {
      const email = newEmail();
      sentMail(app).failWith = new Error('Rejected by Resend: test refusal');

      await askCode(email).expect(200);

      const row = await prisma.otpCode.findFirstOrThrow({
        where: { contact: email },
      });
      const failed = await prisma.outboundMessage.findUniqueOrThrow({
        where: { dedupeKey: `otp:${row.id}` },
      });
      expect(failed).toMatchObject({
        status: OutboundMessageStatus.FAILED,
        attempts: 1,
        lastError: 'Rejected by Resend: test refusal',
      });
      expect(failed.payload).not.toBeNull();

      sentMail(app).failWith = undefined;
      // Backing off (C6-8): the sweep leaves it alone until `retryAfter`.
      expect(failed.retryAfter).not.toBeNull();
      await sweepMessages().expect(200);
      expect(
        await prisma.outboundMessage.findUniqueOrThrow({
          where: { id: failed.id },
        }),
      ).toMatchObject({ status: OutboundMessageStatus.FAILED, attempts: 1 });

      // The backoff run out (the clock is real in this suite, so the row's
      // wait is moved instead; customer-messages crosses it on a clock).
      await prisma.outboundMessage.update({
        where: { id: failed.id },
        data: { retryAfter: new Date(Date.now() - 1000) },
      });
      await sweepMessages().expect(200);
      expect(
        await prisma.outboundMessage.findUniqueOrThrow({
          where: { id: failed.id },
        }),
      ).toMatchObject({
        status: OutboundMessageStatus.SENT,
        attempts: 2,
        retryAfter: null,
      });
      await verifyCall(email, codeSentTo(email)).expect(200);

      // A code's email past the code's expiry is given up, never sent.
      const late = newEmail();
      sentMail(app).configured = false;
      await askCode(late).expect(200);
      const lateRow = await prisma.otpCode.findFirstOrThrow({
        where: { contact: late },
      });
      await prisma.outboundMessage.update({
        where: { dedupeKey: `otp:${lateRow.id}` },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      sentMail(app).configured = true;
      await sweepMessages().expect(200);

      expect(
        await prisma.outboundMessage.findUniqueOrThrow({
          where: { dedupeKey: `otp:${lateRow.id}` },
        }),
      ).toMatchObject({ status: OutboundMessageStatus.FAILED, payload: null });
      expect(sentMail(app).lastTo(late)).toBeUndefined();
    });

    it('refuses the sweep without its token', async () => {
      await request(server())
        .post('/api/v1/internal/sweeps/messages')
        .send()
        .expect(401);
    });
  });

  describe("TAY's cookies", () => {
    it('are never read, logged or returned, and no code reaches a log', async () => {
      const session = await signIn();
      const email = newEmail();
      const tayMember = `tay-member-${randomUUID()}`;
      const tayCookies =
        `tay_refresh_token=${tayMember}; ` +
        `tay_staff_refresh_token=tay-staff-${randomUUID()}`;

      // The service's own JSON logger at every level, as on Cloud Run.
      app.useLogger(new StructuredLogger(true));
      sentMail(app).configured = false;

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
          // Only TAY's cookies: there is no customer cookie to refresh with.
          await refreshCall(tayCookies),
          // A real CNC token under TAY's name is not read either.
          await refreshCall(`tay_refresh_token=${session.cookie}`),
          // Beside a real CNC cookie, TAY's are ignored and the CNC one works.
          await refreshCall(
            `${tayCookies}; ${CUSTOMER_REFRESH_COOKIE}=${session.cookie}`,
          ),
          // A code asked for while mail is not configured, which is logged.
          await request(server())
            .post('/api/v1/auth/code')
            .set('X-Forwarded-For', clientAddress())
            .set('Cookie', tayCookies)
            .send({ email }),
          // A refused customer route.
          await request(server()).get('/api/v1/me').set('Cookie', tayCookies),
        ];
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
        sentMail(app).configured = true;
      }

      expect(responses.map((response) => response.status)).toEqual([
        400, 400, 200, 200, 401,
      ]);
      expect(messageOf(responses[0])).toBe(NO_REFRESH_COOKIE_MESSAGE);
      expect(messageOf(responses[1])).toBe(NO_REFRESH_COOKIE_MESSAGE);

      // The queued email did log, so the capture was live.
      const log = written.join('');
      expect(log).toContain('mail is not configured');

      expect(log).not.toContain(tayMember);
      for (const response of responses) {
        expect(response.text ?? '').not.toContain(tayMember);
        expect(JSON.stringify(response.headers)).not.toContain(tayMember);
      }

      // Send the waiting email to read the code, which was in no log line.
      await request(server())
        .post('/api/v1/internal/sweeps/messages')
        .set(SWEEP_TOKEN_HEADER, SWEEP_TOKEN)
        .send()
        .expect(200);
      expect(log).not.toContain(codeSentTo(email));
    });
  });
});
