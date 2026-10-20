import { UnauthorizedException } from '@nestjs/common';
import type { CncConfigService } from '../../config/cnc.config';
import type { CncTokenPayload } from '../cnc-token.service';
import { CncJwtStrategy } from './cnc-jwt.strategy';

describe('CncJwtStrategy.validate', () => {
  const strategy = new CncJwtStrategy({
    jwtSecret: 'x'.repeat(64),
  } as CncConfigService);

  const payload = (overrides: Record<string, unknown>) =>
    ({
      sub: 'clx8k2p9r0000v8n4h1q2w3e4',
      type: 'STAFF',
      iat: 1,
      exp: 2,
      ...overrides,
    }) as unknown as CncTokenPayload;

  it('accepts a staff or a customer subject', () => {
    expect(strategy.validate(payload({}))).toEqual(payload({}));
    expect(strategy.validate(payload({ type: 'CUSTOMER' })).type).toBe(
      'CUSTOMER',
    );
  });

  it.each([
    ['no subject', { sub: undefined }],
    ['an empty subject', { sub: '' }],
    ['a numeric subject', { sub: 42 }],
    ['an unknown type', { type: 'MEMBER' }],
    ['no type', { type: undefined }],
  ])('refuses %s with a 401', (_label, overrides) => {
    expect(() => strategy.validate(payload(overrides))).toThrow(
      UnauthorizedException,
    );
  });
});
