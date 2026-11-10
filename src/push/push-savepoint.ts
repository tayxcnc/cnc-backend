import { Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/cnc-client';

/**
 * Run a push's database work inside the event's transaction without ever
 * failing it (C10, D1).
 *
 * `createMany({ skipDuplicates })` alone covers only a duplicate. A foreign
 * key, a CHECK, an over-long value or a failed read raises inside Postgres,
 * and Postgres then refuses every later statement of the transaction:
 * without this, a push defect would roll back a paid web order in the
 * Paystack settle (`checkout-payments.service.ts`). So the work runs after
 * `SAVEPOINT cnc_push`; on any error the transaction is rolled back to the
 * savepoint, which undoes the push's writes and nothing of the caller's, a
 * line is logged with `label` and the ids, and the answer is null.
 *
 * The SQL is constant: no value ever reaches `$executeRawUnsafe`.
 */
const logger = new Logger('PushSavepoint');

/** A transaction's client: the savepoint means nothing outside one. */
export type PushTransaction = Prisma.TransactionClient;

export async function withPushSavepoint<T>(
  tx: PushTransaction,
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  await tx.$executeRawUnsafe('SAVEPOINT cnc_push');

  try {
    const result = await fn();

    await tx.$executeRawUnsafe('RELEASE SAVEPOINT cnc_push');

    return result;
  } catch (error) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT cnc_push');
    // Ids and the error's class only: a Prisma message can quote a value.
    logger.error(
      `Push not queued (${label}): ` +
        `${error instanceof Error ? error.name : 'unknown error'}.`,
    );

    return null;
  }
}
