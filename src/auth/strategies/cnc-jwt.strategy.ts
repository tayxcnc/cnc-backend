import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { SubjectType } from '../../../generated/cnc-client';
import { CncConfigService } from '../../config/cnc.config';
import type { CncTokenPayload } from '../cnc-token.service';

/**
 * Passport strategy name for CNC access tokens. Named rather than the
 * default `jwt`, so no other strategy can ever shadow it.
 */
export const CNC_JWT_STRATEGY = 'cnc-jwt';

/**
 * Checks the signature and expiry of a CNC access token, copied from TAY's
 * `TayJwtStrategy`.
 *
 * This layer answers "is this a genuine, unexpired CNC token" and nothing
 * more; whether the holder may use the route is the guards' question, which
 * is what lets a token of the wrong realm be a 403 rather than a 401. A
 * token signed with TAY's secret fails here, as 401: the auth half of the
 * isolation the separate databases give.
 *
 * The algorithm is pinned to HS256 here as well as at the signer, so a token
 * naming any other algorithm in its header is refused before its signature
 * is considered.
 */
@Injectable()
export class CncJwtStrategy extends PassportStrategy(
  Strategy,
  CNC_JWT_STRATEGY,
) {
  constructor(config: CncConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // Enforced here, so an expired token is a 401 on every route with no
      // way to opt out.
      ignoreExpiration: false,
      secretOrKey: config.jwtSecret,
      algorithms: ['HS256'],
    });
  }

  /**
   * Runs after the signature and expiry have passed. The shape check stops a
   * token signed with CNC's secret by some other code path from being taken
   * for a subject token just because it verified.
   */
  validate(payload: CncTokenPayload): CncTokenPayload {
    const hasValidShape =
      typeof payload?.sub === 'string' &&
      payload.sub.length > 0 &&
      (payload.type === SubjectType.STAFF ||
        payload.type === SubjectType.CUSTOMER);

    if (!hasValidShape) {
      throw new UnauthorizedException('Malformed token payload.');
    }

    return payload;
  }
}
