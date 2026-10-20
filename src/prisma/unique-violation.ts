import { UNIQUE_VIOLATION, isPrismaErrorCode } from './prisma-error';

/**
 * The columns named by a Prisma P2002 unique-constraint violation. Empty for
 * every other error.
 *
 * `meta` belongs to the driver, not to us, and it has already changed shape
 * once. Prisma 6's engine reported `meta.target: ["email"]`. Prisma 7 hands
 * queries to a driver adapter, and node-pg reports the violated constraint by
 * its Postgres name instead: `meta.driverAdapterError.cause.constraint.index`
 * is `"Customer_email_key"` and there is no `target` at all. A helper that
 * reads only one shape turns every deliberate 409 into an unhandled 500,
 * which is caught only if an e2e suite asserts on the status.
 *
 * Both shapes are read. The Prisma 7 constraint name is Prisma's own
 * convention, `<Model>_<field>[_<field>…]_key`, so the field names are
 * recovered by stripping the model prefix and the `_key` suffix. That holds
 * for every unique index Prisma generates from `@unique` and `@@unique`, and
 * for the camelCase field names this schema uses; a field name containing an
 * underscore would split wrongly, which is one more reason the schema has
 * none. Anything unrecognised still returns `[]`, so an unexpected shape
 * produces a 500 the caller can see rather than a wrong 409.
 *
 * In `src/prisma` beside `prisma-error.ts`, for the reason given there.
 */
export function uniqueViolationTargets(error: unknown): string[] {
  if (!isPrismaErrorCode(error, UNIQUE_VIOLATION)) {
    return [];
  }

  const meta = error.meta;

  // Prisma 6: the engine names the columns directly.
  const target = meta?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === 'string') return [target];

  // Prisma 7 with a driver adapter: the driver names the constraint.
  const constraint = readConstraint(meta);
  if (constraint === undefined) return [];

  if (Array.isArray(constraint.fields)) {
    return constraint.fields.map(String);
  }

  const modelName = typeof meta?.modelName === 'string' ? meta.modelName : '';
  const index = typeof constraint.index === 'string' ? constraint.index : '';

  if (index === '' || !index.endsWith('_key')) return [];

  const withoutSuffix = index.slice(0, -'_key'.length);
  const prefix = `${modelName}_`;
  const fieldPart =
    modelName !== '' && withoutSuffix.startsWith(prefix)
      ? withoutSuffix.slice(prefix.length)
      : withoutSuffix;

  return fieldPart.split('_').filter((field) => field !== '');
}

/** `meta.driverAdapterError.cause.constraint`, or undefined at any missing step. */
function readConstraint(
  meta: Record<string, unknown> | undefined,
): { index?: unknown; fields?: unknown } | undefined {
  const adapterError = meta?.driverAdapterError;
  if (typeof adapterError !== 'object' || adapterError === null) {
    return undefined;
  }

  const cause = (adapterError as Record<string, unknown>).cause;
  if (typeof cause !== 'object' || cause === null) return undefined;

  const constraint = (cause as Record<string, unknown>).constraint;
  if (typeof constraint !== 'object' || constraint === null) return undefined;

  return constraint;
}
