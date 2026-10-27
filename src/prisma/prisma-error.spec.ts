import { Prisma } from '../../generated/cnc-client';
import {
  RECORD_NOT_FOUND,
  UNIQUE_VIOLATION,
  isPrismaErrorCode,
} from './prisma-error';

/**
 * No database: the errors are built the way the client builds them, from the
 * generated client's own class.
 */
describe('isPrismaErrorCode', () => {
  const known = (code: string) =>
    new Prisma.PrismaClientKnownRequestError('failed', {
      code,
      clientVersion: 'test',
    });

  it('matches a Prisma error carrying the code', () => {
    expect(isPrismaErrorCode(known('P2002'), UNIQUE_VIOLATION)).toBe(true);
    expect(isPrismaErrorCode(known('P2025'), RECORD_NOT_FOUND)).toBe(true);
  });

  it('does not match a Prisma error carrying another code', () => {
    expect(isPrismaErrorCode(known('P2025'), UNIQUE_VIOLATION)).toBe(false);
  });

  /**
   * The reason for the `instanceof`: an object that merely carries the code
   * is not a Prisma error, and taking its branch would be a guess.
   */
  it('does not match a look-alike that is not a Prisma error', () => {
    expect(isPrismaErrorCode({ code: 'P2002' }, UNIQUE_VIOLATION)).toBe(false);
    expect(
      isPrismaErrorCode(
        Object.assign(new Error('x'), { code: 'P2002' }),
        UNIQUE_VIOLATION,
      ),
    ).toBe(false);
    expect(isPrismaErrorCode(undefined, UNIQUE_VIOLATION)).toBe(false);
  });
});
