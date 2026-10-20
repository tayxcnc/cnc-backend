/**
 * What the readiness probe reports about the database.
 *
 * - `ok`            — answered a trivial query inside the timeout.
 * - `unreachable`   — did not. The process is up and cannot serve.
 * - `unconfigured`  — no probe is registered. The deployed service always
 *                     registers `CncPrismaService`; a test module that wires
 *                     no database is the case this covers.
 */
export type DatabaseHealth = 'ok' | 'unreachable' | 'unconfigured';

/**
 * Something the health controller can ask about the database.
 *
 * Behind a token for the same reason `REDIS_HEALTH_PROBE` is: `src/health`
 * does not import the Prisma service, so it can be built and tested without a
 * generated client. The root module registers `CncPrismaService` against this
 * token; a module that registers nothing reads `unconfigured` and stays ready,
 * because a process with no database is not waiting on one.
 */
export interface DatabaseHealthProbe {
  probeDatabase(): Promise<DatabaseHealth>;
}

export const DATABASE_HEALTH_PROBE = Symbol('DATABASE_HEALTH_PROBE');

/**
 * How long the probe waits before calling the database unreachable.
 *
 * Three seconds. It has to be shorter than the uptime check's own timeout or a
 * slow database makes the check time out rather than fail, and a timeout and a
 * failure are different alerts. It also has to be long enough that a cold
 * Cloud SQL connection is not reported as an outage.
 */
export const DATABASE_PROBE_TIMEOUT_MS = 3_000;
