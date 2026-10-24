import { Injectable } from '@nestjs/common';
import { RateLimitStore } from '../common/throttler/rate-limit-store';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { CncPrismaService } from '../prisma/cnc-prisma.service';

/**
 * How long a one-time code row is kept after it expires, in hours.
 *
 * A code lives 10 minutes (plan A15), but its row is also the record the
 * customer sign-in (C6) counts to cap issuance per contact and per address.
 * Deleting a row the moment it expired would let a caller who waited out a
 * code reset their own count, so the sweep keeps a day of rows. A cap window
 * longer than this would need this raised with it.
 */
export const OTP_RETENTION_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/** What one run of the tokens sweep deleted, by table. */
export interface TokensSweepResult {
  refreshTokens: number;
  passwordResetTokens: number;
  otpCodes: number;
  idempotencyKeys: number;
  rateLimitCounts: number;
}

/**
 * The daily tokens sweep (plan §5.5, C3-9): expired refresh tokens, expired
 * password-reset tokens, one-time codes a day past their expiry, stored
 * Idempotency-Key responses older than 7 days, and from C8-3 the rate-limit
 * counts whose window and block have ended (an ended count is already a
 * fresh window to `RateLimitStore`).
 *
 * **Housekeeping, never the correctness mechanism.** Every one of these is
 * already checked at use: a refresh token is spent by a conditional UPDATE
 * that refuses an expired one, a code is refused after `expiresAt`, and an
 * old idempotency row only replays an old answer to its own key. Nothing may
 * come to depend on this having run: Cloud Run scales to zero and Scheduler
 * can miss a day. What it stops is tables that only ever grow.
 *
 * **Expiry, never revocation.** A revoked refresh token is left until it
 * expires (TAY's rule): it is the record that a session was ended, and the
 * refresh route answers the same 401 for revoked as for unknown, so deleting
 * it early would change nothing a caller sees and would lose the record.
 *
 * Separate statements rather than one transaction: the tables share nothing,
 * and one succeeding alone is better than none. Each is a single DELETE on
 * an indexed timestamp.
 */
@Injectable()
export class TokensSweepService {
  constructor(
    private readonly prisma: CncPrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly rateLimits: RateLimitStore,
  ) {}

  async sweep(now: Date): Promise<TokensSweepResult> {
    const refreshTokens = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });

    const passwordResetTokens = await this.prisma.passwordResetToken.deleteMany(
      { where: { expiresAt: { lt: now } } },
    );

    const otpCodes = await this.prisma.otpCode.deleteMany({
      where: {
        expiresAt: {
          lt: new Date(now.getTime() - OTP_RETENTION_HOURS * HOUR_MS),
        },
      },
    });

    const idempotencyKeys = await this.idempotency.deleteExpired(now);

    const rateLimitCounts = await this.rateLimits.deleteEnded(now);

    return {
      refreshTokens: refreshTokens.count,
      passwordResetTokens: passwordResetTokens.count,
      otpCodes: otpCodes.count,
      idempotencyKeys,
      rateLimitCounts,
    };
  }
}
