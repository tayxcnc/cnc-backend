/*
 * The sweep routes need a token, and the guard reads it through
 * CncConfigService from the environment, so it is set before the app is
 * built. `ConfigModule` loads `.env` without overwriting a value already
 * present, so this wins whatever the developer's file says and the suite is
 * the same on every machine and in CI. Jest gives each test file its own
 * copy of process.env.
 */
const SWEEP_TOKEN = `sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`;

process.env.CNC_SWEEP_TOKEN = SWEEP_TOKEN;

import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { OtpPurpose, StaffRole, SubjectType } from '../generated/cnc-client';
import { CncTokenService } from '../src/auth/cnc-token.service';
import {
  SWEEP_TOKEN_HEADER,
  SWEEP_TOKEN_REFUSED_MESSAGE,
} from '../src/internal/sweep-token.guard';
import { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { createTestApp } from './create-test-app';
import { accessTokenFor, createStaffAccount } from './staff-fixtures';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface TokensSweepBody {
  refreshTokens: number;
  passwordResetTokens: number;
  otpCodes: number;
  idempotencyKeys: number;
}

/**
 * `POST /api/v1/internal/sweeps/tokens` (C3-9) behind `SweepTokenGuard`.
 *
 * The sweep is global by nature and every other suite writes to the same
 * database in parallel, so the counts in a response are a floor, never an
 * equality. What is asserted is that the rows this suite planted to be
 * swept are gone and the rows it planted beside them are not.
 */
describe('sweeps (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: CncPrismaService;
  let staffId: string;

  /**
   * "Send no header at all", as a value that is not `undefined`: a default
   * parameter fires on an explicit `undefined`, so `sweep(undefined)` would
   * quietly send the valid token and a 401 test would pass for nothing.
   */
  const NO_TOKEN = Symbol('no sweep token');

  const sweep = (token: string | typeof NO_TOKEN = SWEEP_TOKEN) => {
    const call = request(app.getHttpServer()).post(
      '/api/v1/internal/sweeps/tokens',
    );

    return token === NO_TOKEN ? call : call.set(SWEEP_TOKEN_HEADER, token);
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(CncPrismaService);

    staffId = (
      await createStaffAccount(prisma, StaffRole.WAITER, {
        emailPrefix: 'sweeps',
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  const unique = () => `sweeps-${randomUUID()}`;
  const hash = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  async function refreshToken(expiresAt: Date, revoked = false) {
    const row = await prisma.refreshToken.create({
      data: {
        tokenHash: hash(unique()),
        subjectId: staffId,
        subjectType: SubjectType.STAFF,
        expiresAt,
        revokedAt: revoked ? new Date() : null,
      },
      select: { id: true },
    });

    return row.id;
  }

  async function resetToken(expiresAt: Date) {
    const row = await prisma.passwordResetToken.create({
      data: { tokenHash: hash(unique()), staffId, expiresAt },
      select: { id: true },
    });

    return row.id;
  }

  async function otpCode(expiresAt: Date) {
    const row = await prisma.otpCode.create({
      data: {
        purpose: OtpPurpose.SIGN_IN,
        contact: `${unique()}@cnc.test`,
        codeHash: hash(unique()),
        expiresAt,
        resendAfter: new Date(expiresAt.getTime() - 9 * MINUTE_MS),
      },
      select: { id: true },
    });

    return row.id;
  }

  async function idempotencyKey(createdAt: Date) {
    const row = await prisma.idempotencyKey.create({
      data: {
        scope: `staff:${staffId}`,
        key: randomUUID(),
        route: 'POST /api/v1/sweeps-probe',
        requestHash: hash(unique()),
        responseStatus: 201,
        responseBody: { ok: true },
        createdAt,
      },
      select: { id: true },
    });

    return row.id;
  }

  const exists = {
    refreshToken: async (id: string) =>
      (await prisma.refreshToken.findUnique({ where: { id } })) !== null,
    resetToken: async (id: string) =>
      (await prisma.passwordResetToken.findUnique({ where: { id } })) !== null,
    otpCode: async (id: string) =>
      (await prisma.otpCode.findUnique({ where: { id } })) !== null,
    idempotencyKey: async (id: string) =>
      (await prisma.idempotencyKey.findUnique({ where: { id } })) !== null,
  };

  describe('the guard', () => {
    it('answers 401 with no token at all', async () => {
      const refused = await sweep(NO_TOKEN).expect(401);

      expect((refused.body as { message: string }).message).toBe(
        SWEEP_TOKEN_REFUSED_MESSAGE,
      );
    });

    it('answers 401 with a wrong token, the same message every time', async () => {
      for (const wrong of [
        'not-the-token',
        // Right length, wrong content: the length check cannot be what
        // refuses this one, so the comparison itself is doing the work.
        'x'.repeat(SWEEP_TOKEN.length),
        // An empty header is not "no token" to Express, and must not pass.
        '',
        // A prefix of the right token.
        SWEEP_TOKEN.slice(0, -1),
      ]) {
        const refused = await sweep(wrong).expect(401);

        expect((refused.body as { message: string }).message).toBe(
          SWEEP_TOKEN_REFUSED_MESSAGE,
        );
      }
    });

    it('refuses before doing any work', async () => {
      const expired = await refreshToken(new Date(Date.now() - DAY_MS));

      await sweep('not-the-token').expect(401);

      expect(await exists.refreshToken(expired)).toBe(true);
    });

    it('is not a staff route: a staff access token does not open it', async () => {
      const token = await accessTokenFor(
        app.get(CncTokenService, { strict: false }),
        staffId,
      );

      await request(app.getHttpServer())
        .post('/api/v1/internal/sweeps/tokens')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });
  });

  describe('POST /internal/sweeps/tokens with the right token', () => {
    it('deletes what has expired and keeps everything else', async () => {
      const now = Date.now();

      const expiredRefresh = await refreshToken(new Date(now - DAY_MS));
      const expiredRevoked = await refreshToken(new Date(now - DAY_MS), true);
      const liveRefresh = await refreshToken(new Date(now + 7 * DAY_MS));
      const liveRevoked = await refreshToken(new Date(now + 7 * DAY_MS), true);

      const expiredReset = await resetToken(new Date(now - MINUTE_MS));
      const liveReset = await resetToken(new Date(now + HOUR_MS));

      const staleCode = await otpCode(new Date(now - 25 * HOUR_MS));
      const recentCode = await otpCode(new Date(now - HOUR_MS));
      const liveCode = await otpCode(new Date(now + 5 * MINUTE_MS));

      const oldKey = await idempotencyKey(new Date(now - 8 * DAY_MS));
      const youngKey = await idempotencyKey(new Date(now - 6 * DAY_MS));

      const body = (await sweep().expect(200)).body as TokensSweepBody;

      expect(Object.keys(body).sort()).toEqual([
        'idempotencyKeys',
        'otpCodes',
        'passwordResetTokens',
        'refreshTokens',
      ]);
      expect(body.refreshTokens).toBeGreaterThanOrEqual(2);
      expect(body.passwordResetTokens).toBeGreaterThanOrEqual(1);
      expect(body.otpCodes).toBeGreaterThanOrEqual(1);
      expect(body.idempotencyKeys).toBeGreaterThanOrEqual(1);

      expect(await exists.refreshToken(expiredRefresh)).toBe(false);
      expect(await exists.refreshToken(expiredRevoked)).toBe(false);
      expect(await exists.refreshToken(liveRefresh)).toBe(true);
      // Revoked but unexpired: the record that a session was ended, kept
      // until the day it expires.
      expect(await exists.refreshToken(liveRevoked)).toBe(true);

      expect(await exists.resetToken(expiredReset)).toBe(false);
      expect(await exists.resetToken(liveReset)).toBe(true);

      // A code is kept a day past its expiry, for the issuance caps.
      expect(await exists.otpCode(staleCode)).toBe(false);
      expect(await exists.otpCode(recentCode)).toBe(true);
      expect(await exists.otpCode(liveCode)).toBe(true);

      expect(await exists.idempotencyKey(oldKey)).toBe(false);
      expect(await exists.idempotencyKey(youngKey)).toBe(true);
    });

    it('is safe to run twice', async () => {
      const expired = await refreshToken(new Date(Date.now() - DAY_MS));

      await sweep().expect(200);
      expect(await exists.refreshToken(expired)).toBe(false);

      await sweep().expect(200);
    });
  });
});
