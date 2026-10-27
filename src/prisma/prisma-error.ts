import { Prisma } from '../../generated/cnc-client';

/** A unique constraint was violated. */
export const UNIQUE_VIOLATION = 'P2002';

/** The row an update or delete named does not exist. */
export const RECORD_NOT_FOUND = 'P2025';

/**
 * Whether a caught value is a Prisma error carrying a particular code.
 *
 * `catch` binds `any`, so reading `.code` off the caught value directly is
 * unchecked: it compiles against an error of any shape at all, and a driver
 * that stopped setting `code` would silently take the wrong branch rather than
 * fail. The `instanceof` narrows to Prisma's own class first, which is what
 * makes the comparison meaningful.
 *
 * Declared as a type predicate rather than returning a plain boolean, so a
 * caller that goes on to read `meta` gets it from the narrowed type instead of
 * casting the caught value back. A cast there would compile whatever the value
 * actually was, which is the failure this function exists to prevent.
 *
 * In `src/prisma` rather than `src/common`, because it narrows against the
 * generated client's error class. `src/common` imports nothing generated, so
 * its helpers compile and test without `prisma generate`.
 */
export function isPrismaErrorCode(
  error: unknown,
  code: string,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}
