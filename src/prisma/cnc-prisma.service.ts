import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/cnc-client';
import { CncConfigService } from '../config/cnc.config';
import {
  type DatabaseHealth,
  DATABASE_PROBE_TIMEOUT_MS,
} from '../health/database-health.token';

/**
 * Connection pool settings.
 *
 * The two timeouts match what Prisma 6's built-in engine did rather than what
 * node-pg does on its own. Prisma 7 hands the pool to the driver, and
 * node-pg's defaults differ from the engine's in two ways that matter on Cloud
 * Run: it never times out a connection attempt (the engine gave up after 5 s),
 * and it closes idle connections after 10 s (the engine kept them for 300 s).
 * The first turns a database outage into requests that hang instead of fail;
 * the second churns connections through the Cloud SQL proxy on every quiet
 * minute.
 *
 * `max` is explicit because CNC staging shares a small Cloud SQL instance
 * with TAY (db-f1-micro, about 25 connections), and TAY's own pools can
 * already ask for more than that (plan §19, risk 1). node-pg's default of 10
 * per instance would let CNC alone take most of it. Three per instance, two
 * instances at most, keeps CNC's share at six.
 */
const POOL = {
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 300_000,
  max: 3,
} as const;

/**
 * Prisma client for the CNC database.
 *
 * Extends the client generated from prisma/schema.prisma into
 * `generated/cnc-client`. It is imported from that path and never from
 * `@prisma/client`: the generator writes to a custom output directory, so the
 * package-level import would resolve to an ungenerated stub. The explicit
 * path is what makes "this service reaches exactly this schema" true at
 * compile time rather than by convention.
 *
 * Since Prisma 7 the client no longer carries its own database engine: it is
 * handed a driver adapter, and this is the one place it is built. The URL
 * comes through CncConfigService — the same allowlisted door every other
 * CNC_ value comes through — so `CNC_DB_URL` is read exactly once in the
 * service, in cnc.config.ts, and nowhere else. `prisma.config.ts` reads it
 * separately for the CLI; the running service never loads that file.
 */
@Injectable()
export class CncPrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: CncConfigService) {
    super({
      adapter: new PrismaPg({ connectionString: config.databaseUrl, ...POOL }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Can this process reach the database right now?
   *
   * Implements `DatabaseHealthProbe` for the readiness route. It lives on the
   * Prisma service rather than in `src/health` so that `src/health` never
   * imports the generated client — the same reasoning that put the Redis
   * probe behind a token.
   *
   * `SELECT 1` because the question is whether the connection works, not
   * whether any particular table does. A query against a real table would also
   * fail when a migration is mid-flight, and reporting "not ready" during a
   * deploy is how a rolling update stalls itself.
   *
   * The timeout is the point of the method. Without one, an unreachable
   * database makes this request hang until the pool's own timeout, and the
   * uptime check times out instead of receiving a 503 — which is a different
   * alert, and a less useful one. `Promise.race` rather than a query-level
   * timeout because the adapter does not expose one.
   */
  async probeDatabase(): Promise<DatabaseHealth> {
    let timer: NodeJS.Timeout | undefined;

    try {
      const timeout = new Promise<'unreachable'>((resolve) => {
        timer = setTimeout(
          () => resolve('unreachable'),
          DATABASE_PROBE_TIMEOUT_MS,
        );
      });

      const query = this.$queryRaw`SELECT 1`.then<'ok'>(() => 'ok');

      return await Promise.race([query, timeout]);
    } catch {
      // The reason is not reported to the caller — a connection error can
      // carry the host and the user — and the exception filter is not
      // involved, because this route answers 503 rather than throwing. The
      // detail is worth nothing here and is already in the pool's own logs.
      return 'unreachable';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
