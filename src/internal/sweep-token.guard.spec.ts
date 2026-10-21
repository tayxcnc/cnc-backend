import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { CncConfigService } from '../config/cnc.config';
import {
  SWEEP_TOKEN_HEADER,
  SWEEP_TOKEN_REFUSED_MESSAGE,
  SweepTokenGuard,
  isSweepTokenMatch,
} from './sweep-token.guard';

describe('isSweepTokenMatch', () => {
  const TOKEN = 'b'.repeat(64);

  it('accepts the configured token', () => {
    expect(isSweepTokenMatch(TOKEN, TOKEN)).toBe(true);
  });

  it.each([
    ['nothing configured', undefined, TOKEN],
    ['an empty configuration', '', ''],
    ['no header', TOKEN, undefined],
    ['an empty header', TOKEN, ''],
    ['a shorter token', TOKEN, TOKEN.slice(1)],
    ['a longer token', TOKEN, `${TOKEN}b`],
    ['the right length, wrong content', TOKEN, 'c'.repeat(64)],
    ['a header that is not text', TOKEN, ['b'.repeat(64)]],
  ])('refuses %s', (_case, expected, presented) => {
    expect(isSweepTokenMatch(expected, presented)).toBe(false);
  });
});

describe('SweepTokenGuard', () => {
  function contextWith(header: string | undefined): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          header: (name: string) =>
            name === SWEEP_TOKEN_HEADER ? header : undefined,
        }),
      }),
    } as unknown as ExecutionContext;
  }

  const guardWith = (sweepToken: string | undefined) =>
    new SweepTokenGuard({ sweepToken } as CncConfigService);

  it('lets the right token through', () => {
    expect(guardWith('secret').canActivate(contextWith('secret'))).toBe(true);
  });

  it('answers one 401 for a wrong, a missing and an unconfigured token', () => {
    for (const [configured, presented] of [
      ['secret', 'wrong!'],
      ['secret', undefined],
      [undefined, 'secret'],
    ] as const) {
      const guard = guardWith(configured);

      expect(() => guard.canActivate(contextWith(presented))).toThrow(
        new UnauthorizedException(SWEEP_TOKEN_REFUSED_MESSAGE),
      );
    }
  });
});
