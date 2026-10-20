import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Optional,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { currentRequestId } from '../common/request-context';
import {
  DATABASE_HEALTH_PROBE,
  type DatabaseHealthProbe,
} from './database-health.token';
import { HealthResponse } from './dto/health.response';
import { ReadinessResponse } from './dto/readiness.response';
import {
  REDIS_HEALTH_PROBE,
  type RedisHealthProbe,
} from './redis-health.token';
import { SERVICE_NAME } from './service-name.token';

/**
 * Liveness probe.
 *
 * Resolves to /api/v1/health via the global prefix set in bootstrap().
 *
 * The service name is injected, not derived from an environment variable, so
 * a misconfigured environment can never make this service report itself as
 * something else. There is deliberately no database call here: this answers
 * "is the process up", not "is the database reachable".
 *
 * Redis is the one dependency reported, and it is reported rather than
 * checked: the `redis` field says whether the cache answered, and the HTTP
 * status stays 200 whatever it says. A process that has lost its cache is
 * up, serving, and rate limiting in memory — turning that into a failed
 * probe would have Cloud Run restart healthy containers because a cache
 * blinked. Both probes are optional at the DI level: a module that has not
 * wired one registers nothing and reads `unconfigured`.
 */
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(SERVICE_NAME) private readonly serviceName: string,
    @Optional()
    @Inject(REDIS_HEALTH_PROBE)
    private readonly redisProbe?: RedisHealthProbe,
    @Optional()
    @Inject(DATABASE_HEALTH_PROBE)
    private readonly databaseProbe?: DatabaseHealthProbe,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'getHealth',
    summary: 'Liveness probe',
    description:
      'Reports that the process is up and which service it is. Takes no ' +
      'parameters, requires no token, and touches no database — a 200 ' +
      'here says nothing about whether the database is reachable. The ' +
      '`redis` field is informational: `unavailable` or `unconfigured` ' +
      'means rate limits are counted per instance, and the status is still ' +
      '200.',
  })
  @ApiResponse({
    status: 200,
    description: 'The process is up.',
    type: HealthResponse,
  })
  async check(): Promise<HealthResponse> {
    const redis =
      this.redisProbe === undefined
        ? 'unconfigured'
        : await this.redisProbe.probeRedis();

    return {
      status: 'ok',
      service: this.serviceName,
      timestamp: new Date().toISOString(),
      redis,
    };
  }

  /**
   * Readiness probe — the one the uptime check calls.
   *
   * `@Res({ passthrough: true })` rather than throwing a
   * `ServiceUnavailableException`: the 503 has a body worth reading, and
   * throwing would route it through the exception filter, which would keep the
   * shape but make the route's own contract harder to see. Passthrough leaves
   * Nest in charge of serialisation and only borrows the status code.
   *
   * No auth, deliberately. A monitoring check cannot hold a credential without
   * that credential being somewhere a monitoring system can read it, and this
   * route discloses nothing an attacker does not already learn by watching
   * whether the service answers at all.
   */
  @Get('ready')
  @ApiOperation({
    operationId: 'getReadiness',
    summary: 'Readiness probe',
    description:
      'Answers whether this process can serve a request, which means ' +
      'reaching the database. 200 when it can, 503 when it cannot. This is ' +
      'the route an uptime check should call: /health stays 200 through a ' +
      'database outage by design, so a check pointed there stays green ' +
      'while nothing works. Requires no token.',
  })
  @ApiResponse({
    status: 200,
    description: 'The database answered. The process can serve.',
    type: ReadinessResponse,
  })
  @ApiResponse({
    status: 503,
    description:
      'The database did not answer inside the timeout. The body carries the ' +
      'request id so the attempt can be found in the logs.',
    type: ReadinessResponse,
  })
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessResponse> {
    const [database, redis] = await Promise.all([
      this.databaseProbe === undefined
        ? Promise.resolve<'unconfigured'>('unconfigured')
        : this.databaseProbe.probeDatabase(),
      this.redisProbe === undefined
        ? Promise.resolve<'unconfigured'>('unconfigured')
        : this.redisProbe.probeRedis(),
    ]);

    // Only the database decides. Redis is reported for the same reason it is
    // on /health — a process without its cache is serving.
    const ready = database !== 'unreachable';

    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    const body: ReadinessResponse = {
      status: ready ? 'ready' : 'not-ready',
      database,
      redis,
      service: this.serviceName,
      timestamp: new Date().toISOString(),
    };

    if (!ready) {
      const requestId = currentRequestId();
      if (requestId !== undefined) body.requestId = requestId;
    }

    return body;
  }
}
