import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { type Prisma, SubjectType } from '../../generated/cnc-client';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { forgetPushSubject, type PushForgetWriter } from '../push/push-forget';

/** Access token lifetime (A14). Short, because it cannot be revoked once issued. */
export const ACCESS_TOKEN_TTL = '15m';

/** Refresh token lifetime: seven days, TAY's. Revocable, see revokeAllForSubject. */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Entropy of a raw refresh token: 32 bytes, 256 bits. */
const REFRESH_TOKEN_BYTES = 32;

/**
 * How long after its rotation a spent refresh token may come back without
 * being treated as a replay: two tabs refreshing with one cookie at the same
 * moment send it twice, and the loser arrives within a round trip. Ten
 * seconds covers a slow network; a copy used later is reuse.
 */
export const REFRESH_REUSE_GRACE_MS = 10_000;

/**
 * The one refusal for a refresh token that cannot be spent: unknown,
 * expired, already rotated, of the other realm, or belonging to an account
 * that can no longer hold a session. One sentence for all of them, so the
 * answer never tells a caller which tokens exist. TAY's wording.
 */
export const INVALID_REFRESH_TOKEN_MESSAGE =
  'Invalid, expired or revoked refresh token.';

/**
 * The complete CNC access token payload: these claims and no others.
 *
 * Only who the subject is. **No role claim**, unlike TAY's token: the guard
 * reads the role from the row on every request (A14), so a role claim could
 * only ever be stale, and a claim nobody may trust is one somebody will
 * eventually trust. No `iss` or `aud` either: a CNC token is a token that
 * verifies against CNC's secret, and TAY's secret is a different one.
 */
export interface CncTokenPayload {
  /** Staff.id or Customer.id, per `type`. */
  sub: string;
  type: SubjectType;
  iat: number;
  exp: number;
}

/** What the signer is given; `iat` and `exp` are appended by the signer. */
type CncTokenClaims = Omit<CncTokenPayload, 'iat' | 'exp'>;

export interface CncTokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * A Prisma client or an interactive transaction's client: the refresh
 * tokens, and from C10 what `forgetPushSubject` deletes beside them.
 */
type TokenWriter = Pick<Prisma.TransactionClient, 'refreshToken'> &
  PushForgetWriter;

/**
 * Issues, rotates and revokes CNC tokens, copied from TAY's
 * `TayTokenService`.
 *
 * Refresh tokens are stored as a plain SHA-256 digest, never argon2: a
 * refresh token is 256 random bits with nothing to guess, and SHA-256 is
 * deterministic, so the digest is the lookup key and the unique index finds
 * the row in one query. Passwords are the opposite case (`password.ts`).
 *
 * **Changed from TAY:** spending a refresh token is one conditional UPDATE
 * (`revokedAt IS NULL`, not expired, of the expected realm), not a read
 * followed by a write. Two refreshes racing with the same cookie, which a
 * till with two tabs open produces, cannot both succeed: the second matches
 * no row and is refused like any spent token. And revocation can join the
 * caller's transaction, so a password change and the end of the old
 * sessions commit together or not at all.
 */
@Injectable()
export class CncTokenService {
  private readonly logger = new Logger(CncTokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: CncPrismaService,
  ) {}

  /**
   * A fresh access and refresh pair. The returned `refreshToken` is the only
   * time the raw value exists outside the client; only its digest is stored.
   */
  async issueTokenPair(
    subjectId: string,
    subjectType: SubjectType,
  ): Promise<CncTokenPair> {
    const claims: CncTokenClaims = { sub: subjectId, type: subjectType };

    const accessToken = await this.jwt.signAsync(claims, {
      expiresIn: ACCESS_TOKEN_TTL,
    });

    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');

    await this.prisma.refreshToken.create({
      data: {
        tokenHash: CncTokenService.digest(refreshToken),
        subjectId,
        subjectType,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    return { accessToken, refreshToken };
  }

  /**
   * Spend a refresh token and say whose it was.
   *
   * Single use: the row is revoked by the same statement that checks it, so
   * a stolen token works at most once, and a spent token presented again
   * ends every session its subject holds (`endSessionsOnReplay`), so the
   * theft does not outlive its discovery. A token of the other realm matches
   * nothing and is refused **without** being revoked, so a customer cookie
   * sent to the staff route signs nobody out.
   */
  async redeemRefreshToken(
    rawToken: string,
    subjectType: SubjectType,
  ): Promise<string> {
    const tokenHash = CncTokenService.digest(rawToken);
    const now = new Date();

    const { count } = await this.prisma.refreshToken.updateMany({
      where: {
        tokenHash,
        subjectType,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now, rotated: true },
    });

    if (count !== 1) {
      await this.endSessionsOnReplay(tokenHash, subjectType, now);

      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    const record = await this.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash },
      select: { subjectId: true },
    });

    return record.subjectId;
  }

  /**
   * Reuse detection: a token already spent by a refresh, presented again,
   * ends every session its subject holds.
   *
   * Rotation means the browser's cookie jar holds only the newest token, so
   * an older one comes back only as a copy: a stolen cookie whose thief
   * refreshed first, or the real client after the thief did. Either way one
   * of the two chains belongs to someone else, and without this the thief's
   * chain renews itself for as long as they like while the real person sees
   * only an ordinary sign-out. Revoking everything ends both; the real
   * person signs in again, the thief cannot.
   *
   * Not a replay: an unknown digest, the other realm's token (it signs
   * nobody out, as above), an expired one, or one revoked by a sign-out, a
   * password change or an account change (`rotated` false: stale, not
   * copied). And not within `REFRESH_REUSE_GRACE_MS` of its rotation, which
   * is the loser of two tabs refreshing with one cookie at the same moment.
   */
  private async endSessionsOnReplay(
    tokenHash: string,
    subjectType: SubjectType,
    now: Date,
  ): Promise<void> {
    const spent = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        subjectId: true,
        subjectType: true,
        revokedAt: true,
        rotated: true,
        expiresAt: true,
      },
    });

    if (
      spent === null ||
      spent.subjectType !== subjectType ||
      !spent.rotated ||
      spent.revokedAt === null ||
      spent.expiresAt <= now ||
      now.getTime() - spent.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS
    ) {
      return;
    }

    const revoked = await this.revokeAllForSubject(
      spent.subjectId,
      subjectType,
    );

    // The subject, never the token: a log line is not a place for a
    // credential, even a spent one.
    this.logger.warn(
      `A rotated refresh token was presented again; ended ${revoked} ` +
        `session(s) of ${subjectType} ${spent.subjectId}.`,
    );
  }

  /**
   * Revoke every outstanding refresh token a subject holds: sign-out on
   * every device, a password change, an admin reset, and (C3-6) a role,
   * email or status change. Pass the command's transaction client so the
   * revocation commits with the change that caused it.
   *
   * Access tokens already issued stay valid until they expire, at most
   * fifteen minutes, but the staff guard re-reads the account on every
   * request, so a deactivated account is refused at once anyway.
   *
   * From C10 it also forgets the subject's push devices and the pushes
   * still waiting for them, through the same client (`forgetPushSubject`,
   * D4): every path that ends a person's sessions passes here, so one
   * place stops pushes to a device nobody is signed in on. A device binds
   * again only with a live refresh token, which an access token still
   * valid after this cannot supply.
   */
  async revokeAllForSubject(
    subjectId: string,
    subjectType: SubjectType,
    client: TokenWriter = this.prisma,
  ): Promise<number> {
    const { count } = await client.refreshToken.updateMany({
      where: { subjectId, subjectType, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await forgetPushSubject(client, subjectType, subjectId);

    return count;
  }

  /**
   * SHA-256 of a raw token, hex: the value stored in `tokenHash` and the key
   * it is looked up by.
   */
  static digest(rawToken: string): string {
    return createHash('sha256').update(rawToken, 'utf8').digest('hex');
  }
}
