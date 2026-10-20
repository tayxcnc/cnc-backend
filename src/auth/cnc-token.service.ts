import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { type Prisma, SubjectType } from '../../generated/cnc-client';
import { CncPrismaService } from '../prisma/cnc-prisma.service';

/** Access token lifetime (A14). Short, because it cannot be revoked once issued. */
export const ACCESS_TOKEN_TTL = '15m';

/** Refresh token lifetime: seven days, TAY's. Revocable, see revokeAllForSubject. */
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Entropy of a raw refresh token: 32 bytes, 256 bits. */
const REFRESH_TOKEN_BYTES = 32;

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

/** A Prisma client or an interactive transaction's client. */
type TokenWriter = Pick<Prisma.TransactionClient, 'refreshToken'>;

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
   * a stolen token works at most once, and the theft shows the next time the
   * real client refreshes and is refused. A token of the other realm matches
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
      data: { revokedAt: now },
    });

    if (count !== 1) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    const record = await this.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash },
      select: { subjectId: true },
    });

    return record.subjectId;
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
