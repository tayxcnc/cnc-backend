/**
 * What the health probe reports about Redis.
 *
 * - `ok`            — configured, connected, and answered a PING.
 * - `unavailable`   — configured but not currently reachable. The service is
 *                     still up; rate limits are counting in memory.
 * - `unconfigured`  — no Redis for this process. The normal state at launch:
 *                     there is no Redis, and rate limits count in memory per
 *                     instance (plan A18).
 *
 * None of these changes the HTTP status. The probe answers "is the process
 * up", and a process that has lost its cache is up.
 */
export type RedisHealth = 'ok' | 'unavailable' | 'unconfigured';

/**
 * Something the health controller can ask about Redis.
 *
 * An interface behind a token rather than a concrete service, so that
 * `src/health` does not depend on a Redis client this service does not yet
 * have. If Redis is added, its service registers against this token; until
 * then nothing does, and the field reads `unconfigured`.
 */
export interface RedisHealthProbe {
  probeRedis(): Promise<RedisHealth>;
}

export const REDIS_HEALTH_PROBE = Symbol('REDIS_HEALTH_PROBE');
