import type { IdempotencyService } from '../idempotency/idempotency.service';
import type { CncPrismaService } from '../prisma/cnc-prisma.service';
import {
  OTP_RETENTION_HOURS,
  TokensSweepService,
} from './tokens-sweep.service';

describe('TokensSweepService', () => {
  const NOW = new Date('2026-10-21T02:00:00.000Z');

  function harness() {
    const calls: Record<string, unknown> = {};
    const deleteMany = (table: string, count: number) =>
      jest.fn((args: unknown) => {
        calls[table] = args;
        return Promise.resolve({ count });
      });

    const prisma = {
      refreshToken: { deleteMany: deleteMany('refreshToken', 3) },
      passwordResetToken: { deleteMany: deleteMany('passwordResetToken', 1) },
      otpCode: { deleteMany: deleteMany('otpCode', 2) },
    };
    const deleteExpired = jest.fn(() => Promise.resolve(4));

    const service = new TokensSweepService(
      prisma as unknown as CncPrismaService,
      { deleteExpired } as unknown as IdempotencyService,
    );

    return { service, calls, deleteExpired };
  }

  it('reports each table’s count', async () => {
    const { service } = harness();

    await expect(service.sweep(NOW)).resolves.toEqual({
      refreshTokens: 3,
      passwordResetTokens: 1,
      otpCodes: 2,
      idempotencyKeys: 4,
    });
  });

  it('deletes tokens by expiry alone, never by revocation', async () => {
    const { service, calls } = harness();

    await service.sweep(NOW);

    expect(calls.refreshToken).toEqual({ where: { expiresAt: { lt: NOW } } });
    expect(calls.passwordResetToken).toEqual({
      where: { expiresAt: { lt: NOW } },
    });
  });

  it('keeps one-time codes for a day past their expiry', async () => {
    const { service, calls } = harness();

    await service.sweep(NOW);

    expect(OTP_RETENTION_HOURS).toBe(24);
    expect(calls.otpCode).toEqual({
      where: { expiresAt: { lt: new Date('2026-10-20T02:00:00.000Z') } },
    });
  });

  it('hands the idempotency keys to IdempotencyService with the same clock', async () => {
    const { service, deleteExpired } = harness();

    await service.sweep(NOW);

    expect(deleteExpired).toHaveBeenCalledWith(NOW);
  });
});
