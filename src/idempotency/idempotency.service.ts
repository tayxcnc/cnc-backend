import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/cnc-client';
import { CncPrismaService } from '../prisma/cnc-prisma.service';
import { uniqueViolationTargets } from '../prisma/unique-violation';
import type { IdempotencyRequest } from './idempotency-key.decorator';

/** The 409 for a key already used with a different request. */
export const IDEMPOTENCY_KEY_REUSED =
  'This Idempotency-Key was already used for a different request.';

/** How long a stored response is kept (plan §4.8). */
export const IDEMPOTENCY_KEY_TTL_DAYS = 7;

/** The result of {@link IdempotencyService.execute}. */
export interface IdempotentResult<T> {
  /** The status the first response was given. */
  status: number;
  /** The first response's body, as JSON (a Date is its ISO string). */
  body: T;
  /** True when this is a stored response returned again. */
  replayed: boolean;
}

/** The arguments of {@link IdempotencyService.execute}. */
export interface IdempotentCommand<T> extends IdempotencyRequest {
  /** From `idempotencyScope`, for the authenticated caller. */
  scope: string;
  /** The status the route answers on success (201 for a create). */
  status: number;
  /**
   * The command. It receives the transaction it must do all its work in, and
   * returns the response body, which must be JSON-serialisable.
   */
  work: (tx: Prisma.TransactionClient) => Promise<T>;
  /** Passed to Prisma's interactive transaction. */
  transaction?: { maxWait?: number; timeout?: number };
}

/**
 * `Idempotency-Key` (A9): a command that runs at most once per key.
 *
 * ## How
 *
 * The key row is inserted **inside the command's own transaction, before the
 * command runs**, and its response is written before the transaction
 * commits. Three cases follow, none of which needs a lock of its own:
 *
 * - **First time:** the insert succeeds, the command runs, and the key and
 *   the command commit together.
 * - **A repeat after the first committed:** the insert hits the unique index
 *   on (`scope`, `key`), the transaction rolls back having done nothing, and
 *   the stored response is returned, with `replayed: true`.
 * - **A repeat while the first is still running** (a phone that gave up and
 *   retried): Postgres makes the second insert wait on the first's
 *   uncommitted index entry. When the first commits, the second fails as
 *   above and replays; if the first rolled back, the second's insert goes
 *   through and it runs the command itself.
 *
 * So a key is never spent on a command that did not happen. **A refused or
 * failed command stores nothing** (its transaction rolled back), and a retry
 * with the same key runs it again: a 409 for a stale version, fixed and
 * retried, is a fresh attempt, not a replay of the refusal.
 *
 * The same key with a different route or request fingerprint is refused
 * with `409` {@link IDEMPOTENCY_KEY_REUSED}, never answered with the other
 * request's response.
 *
 * Anything done outside the transaction (an email, a call to Paystack) is
 * not covered: it must be keyed separately or happen after the commit.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: CncPrismaService) {}

  async execute<T>(
    command: IdempotentCommand<T>,
  ): Promise<IdempotentResult<T>> {
    const { scope, key, route, requestHash, status, work } = command;

    try {
      const body = await this.prisma.$transaction(async (tx) => {
        const { id } = await tx.idempotencyKey.create({
          data: { scope, key, route, requestHash },
          select: { id: true },
        });

        const json = toJson(await work(tx));

        await tx.idempotencyKey.update({
          where: { id },
          data: {
            responseStatus: status,
            responseBody: json === null ? Prisma.JsonNull : json,
          },
        });

        return json;
      }, command.transaction);

      return { status, body: body as T, replayed: false };
    } catch (error) {
      if (!isKeyClash(error)) throw error;
    }

    const stored = await this.prisma.idempotencyKey.findUnique({
      where: { scope_key: { scope, key } },
    });

    // The clash was with a committed row, and rows are removed only by the
    // 7-day sweep, so this is a key swept in the instant between. Answering
    // 409 is safe: the client sees a refusal, not a second run.
    if (
      stored === null ||
      stored.route !== route ||
      stored.requestHash !== requestHash ||
      stored.responseStatus === null
    ) {
      throw new ConflictException(IDEMPOTENCY_KEY_REUSED);
    }

    return {
      status: stored.responseStatus,
      body: stored.responseBody as T,
      replayed: true,
    };
  }

  /**
   * Delete stored responses older than {@link IDEMPOTENCY_KEY_TTL_DAYS}
   * before `now`. For the tokens sweep (C3-9); nothing depends on it having
   * run, because an old row only replays an old answer to its own key.
   * Returns how many rows went.
   */
  async deleteExpired(now: Date): Promise<number> {
    const cutoff = new Date(
      now.getTime() - IDEMPOTENCY_KEY_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    return count;
  }
}

/**
 * The body as it travels: what the first caller receives and what a replay
 * returns are then the same JSON, Dates included.
 */
function toJson(value: unknown): Prisma.InputJsonValue | null {
  if (value === undefined) return null;

  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue | null;
}

/** A unique violation on the key itself, not on anything the command wrote. */
function isKeyClash(error: unknown): boolean {
  const targets = uniqueViolationTargets(error);

  return targets.includes('scope') && targets.includes('key');
}
