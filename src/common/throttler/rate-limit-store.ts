import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { Prisma } from '../../../generated/cnc-client';
import { CncPrismaService } from '../../prisma/cnc-prisma.service';

/**
 * The injection token of the namespace every stored count's key starts
 * with. One value per deployment (`RATE_LIMIT_NAMESPACE_DEPLOYED`), so every
 * instance of the service counts against the same rows; the e2e harness
 * gives each test app its own, so suites running together, and runs
 * minutes apart, never spend each other's counts (`test/create-test-app.ts`).
 */
export const RATE_LIMIT_NAMESPACE = 'CNC_RATE_LIMIT_NAMESPACE';

/** The namespace of the service itself. */
export const RATE_LIMIT_NAMESPACE_DEPLOYED = 'cnc';

/** One counted request, as the store saw it. */
export interface RateLimitHit {
  /** Requests counted in the window, this one included. */
  hits: number;
  /** Whether this request is refused. */
  blocked: boolean;
  /** Whole seconds until a refused key may try again; 0 when not blocked. */
  retryAfterSeconds: number;
  /** Whole seconds until the window ends. */
  windowSecondsLeft: number;
}

/**
 * The most blocked keys one instance remembers (`RateLimitStore.blocked`).
 * A flood from many addresses must not grow the process without bound;
 * a key past the cap is still refused, by its stored row.
 */
export const BLOCKED_KEYS_REMEMBERED = 10_000;

/** A key this instance has seen refused, on its own monotonic clock. */
interface RememberedBlock {
  /** `performance.now()` when the stored block ends. */
  until: number;
  /** `performance.now()` when the stored window ends. */
  windowEndsAt: number;
  hits: number;
}

/** The database's clock, as the columns store it (UTC, no zone). */
const NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/**
 * A row whose window is over and which is not blocked, or whose block is
 * over: the request starts a new window. An ended row the tokens sweep has
 * not deleted yet is therefore just a fresh one.
 */
const FRESH = Prisma.sql`(
  (c."blockedUntil" IS NOT NULL AND c."blockedUntil" <= ${NOW})
  OR (c."blockedUntil" IS NULL AND c."windowEndsAt" <= ${NOW})
)`;

/**
 * Every rate limit's count, stored in `RateLimitCount` (card C8-3), so the
 * limit is one number however many Cloud Run instances answer: an
 * in-memory count (plan A18) gave each instance its own, and a restart
 * forgot it.
 *
 * It is the `ThrottlerStorage` of the one `ThrottlerModule`
 * (`cnc-auth.module.ts`), so every `@Throttle` count in the service is
 * stored, and it counts by hand where a route decides what to count
 * itself (`hit`: the webhook's bad signatures).
 *
 * The semantics are the throttler's own storage's, in a fixed window: the
 * first request opens a window of `windowMs`; the request that goes over
 * `limit` is refused and blocks the key for `blockMs` (the window, unless
 * said otherwise), during which requests are refused and not counted; when
 * the block ends the next request opens a new window. Each request is one
 * atomic `INSERT … ON CONFLICT DO UPDATE` on the key's row, so requests on
 * many instances arriving together are counted one after another by the
 * row's lock, and none is lost. Times are the database's clock, one clock
 * for every instance.
 *
 * **A key this instance has seen blocked is refused from memory until its
 * block ends, with no database round trip** (C8 review). A refusal must
 * shed load: without this, every request of a flood at a public route
 * would still take one of the three pooled connections the till needs, on
 * the instance CNC shares with TAY (plan §19, risk 1). The block's end is
 * the database's, carried over as a duration onto this process's
 * monotonic clock, so a block never ends early here; a request counted on
 * another instance meanwhile is not counted here either, as the stored
 * semantics say (a blocked key's requests are not counted). Many addresses
 * each under their limit are still one write per request: that is the
 * edge's to stop, not the application's.
 */
@Injectable()
export class RateLimitStore implements ThrottlerStorage {
  /** Blocked keys, oldest first (`BLOCKED_KEYS_REMEMBERED`). */
  private readonly blocked = new Map<string, RememberedBlock>();

  constructor(
    private readonly prisma: CncPrismaService,
    @Inject(RATE_LIMIT_NAMESPACE) private readonly namespace: string,
  ) {}

  /** Count one request against `key`; say whether it is refused. */
  async hit(
    key: string,
    limit: number,
    windowMs: number,
    blockMs: number = windowMs,
  ): Promise<RateLimitHit> {
    // A digest, so no row holds an address or an email in the clear.
    const stored = `${this.namespace}:${createHash('sha256').update(key).digest('hex')}`;
    const remembered = this.remembered(stored);

    if (remembered !== null) {
      const now = performance.now();

      return {
        hits: remembered.hits,
        blocked: true,
        retryAfterSeconds: Math.min(
          Math.ceil((remembered.until - now) / 1000),
          Math.ceil(blockMs / 1000),
        ),
        windowSecondsLeft: Math.min(
          Math.max(0, Math.ceil((remembered.windowEndsAt - now) / 1000)),
          Math.ceil(windowMs / 1000),
        ),
      };
    }

    const window = Prisma.sql`(${windowMs}::int * interval '1 millisecond')`;
    const block = Prisma.sql`(${blockMs}::int * interval '1 millisecond')`;

    const [row] = await this.prisma.$queryRaw<
      {
        hits: number;
        windowLeft: number;
        blockLeft: number;
        windowLeftMs: number;
        blockLeftMs: number;
      }[]
    >`
      INSERT INTO "RateLimitCount" AS c ("key", "hits", "windowEndsAt", "blockedUntil")
      VALUES (
        ${stored},
        1,
        ${NOW} + ${window},
        CASE WHEN 1 > ${limit}::int THEN ${NOW} + ${block} END
      )
      ON CONFLICT ("key") DO UPDATE SET
        "hits" = CASE
          WHEN ${FRESH} THEN 1
          WHEN c."blockedUntil" IS NOT NULL THEN c."hits"
          ELSE c."hits" + 1
        END,
        "windowEndsAt" = CASE
          WHEN ${FRESH} THEN EXCLUDED."windowEndsAt"
          ELSE c."windowEndsAt"
        END,
        "blockedUntil" = CASE
          WHEN ${FRESH} THEN EXCLUDED."blockedUntil"
          WHEN c."blockedUntil" IS NOT NULL THEN c."blockedUntil"
          WHEN c."hits" + 1 > ${limit}::int THEN ${NOW} + ${block}
          ELSE NULL
        END
      RETURNING
        "hits",
        GREATEST(0, CEIL(EXTRACT(EPOCH FROM ("windowEndsAt" - ${NOW}))))::int AS "windowLeft",
        GREATEST(0, COALESCE(CEIL(EXTRACT(EPOCH FROM ("blockedUntil" - ${NOW}))), 0))::int AS "blockLeft",
        GREATEST(0, CEIL(EXTRACT(EPOCH FROM ("windowEndsAt" - ${NOW})) * 1000))::int AS "windowLeftMs",
        GREATEST(0, COALESCE(CEIL(EXTRACT(EPOCH FROM ("blockedUntil" - ${NOW})) * 1000), 0))::int AS "blockLeftMs"`;

    if (row.blockLeftMs > 0) {
      const now = performance.now();

      this.remember(stored, {
        until: now + Math.min(row.blockLeftMs, blockMs),
        windowEndsAt: now + Math.min(row.windowLeftMs, windowMs),
        hits: row.hits,
      });
    }

    // The columns keep milliseconds and the clock microseconds, so a
    // rounded instant can read a second over; never more than was set.
    return {
      hits: row.hits,
      blocked: row.blockLeft > 0,
      retryAfterSeconds: Math.min(row.blockLeft, Math.ceil(blockMs / 1000)),
      windowSecondsLeft: Math.min(row.windowLeft, Math.ceil(windowMs / 1000)),
    };
  }

  /** The block this instance remembers for `stored`, while it lasts. */
  private remembered(stored: string): RememberedBlock | null {
    const block = this.blocked.get(stored);

    if (block === undefined) return null;
    if (block.until > performance.now()) return block;

    this.blocked.delete(stored);

    return null;
  }

  /** Remember a block, dropping ended ones, then the oldest, at the cap. */
  private remember(stored: string, block: RememberedBlock): void {
    this.blocked.delete(stored);

    if (this.blocked.size >= BLOCKED_KEYS_REMEMBERED) {
      const now = performance.now();

      for (const [key, held] of this.blocked) {
        if (held.until <= now) this.blocked.delete(key);
      }

      if (this.blocked.size >= BLOCKED_KEYS_REMEMBERED) {
        const oldest = this.blocked.keys().next();

        if (!oldest.done) this.blocked.delete(oldest.value);
      }
    }

    this.blocked.set(stored, block);
  }

  /** `ThrottlerStorage`: the throttler's key already names its count. */
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): ReturnType<ThrottlerStorage['increment']> {
    const hit = await this.hit(key, limit, ttl, blockDuration);

    return {
      totalHits: hit.hits,
      timeToExpire: hit.windowSecondsLeft,
      isBlocked: hit.blocked,
      timeToBlockExpire: hit.retryAfterSeconds,
    };
  }

  /**
   * Delete the counts whose window and block have both ended (the tokens
   * sweep). Housekeeping only: such a row is a fresh window anyway.
   */
  async deleteEnded(now: Date): Promise<number> {
    const deleted = await this.prisma.rateLimitCount.deleteMany({
      where: {
        windowEndsAt: { lt: now },
        OR: [{ blockedUntil: null }, { blockedUntil: { lt: now } }],
      },
    });

    return deleted.count;
  }
}
