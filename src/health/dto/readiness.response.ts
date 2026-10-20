import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { DatabaseHealth } from '../database-health.token';
import type { RedisHealth } from '../redis-health.token';

/**
 * Body of GET /api/v1/health/ready.
 *
 * The difference from `HealthResponse` is the whole point of the route.
 * `/health` answers "is the process up" and stays 200 through a total
 * database outage, deliberately, so that Cloud Run does not restart healthy
 * containers because a dependency blinked. This route answers "can this
 * process actually serve a request", and a database it cannot reach makes it
 * 503.
 *
 * The uptime check points here. `/health` stays the liveness probe.
 */
export class ReadinessResponse {
  @ApiProperty({
    description:
      '`ready` with 200, `not-ready` with 503. The status code and this ' +
      'field always agree; the field exists so a human reading the body ' +
      'does not have to check the code.',
    enum: ['ready', 'not-ready'],
    example: 'ready',
  })
  status!: 'ready' | 'not-ready';

  @ApiProperty({
    description:
      'Whether a trivial query answered inside the timeout. `unreachable` ' +
      'is the only value that makes this route 503. `unconfigured` means ' +
      'no database probe is wired, which is not a fault.',
    enum: ['ok', 'unreachable', 'unconfigured'],
    example: 'ok',
  })
  database!: DatabaseHealth;

  @ApiProperty({
    description:
      'Reported, never decisive. A process without its cache is serving — ' +
      'rate limits count per instance instead of across them — so this ' +
      'never changes the status code.',
    enum: ['ok', 'unavailable', 'unconfigured'],
    example: 'unconfigured',
  })
  redis!: RedisHealth;

  @ApiProperty({
    description: 'Which service answered.',
    enum: ['cnc'],
    example: 'cnc',
  })
  service!: string;

  @ApiProperty({
    description: 'Server time when the probe was answered, ISO 8601.',
    format: 'date-time',
    example: '2026-01-01T09:30:00.000Z',
  })
  timestamp!: string;

  @ApiPropertyOptional({
    description:
      'The request id, echoed so that a failing readiness check can be ' +
      'found in the logs. Present on the 503; omitted on the 200, where ' +
      'the response header carries it and the body has nothing to explain.',
    example: '9f1c2f1e-2f3a-4c8b-9a1e-7d5c3b2a1098',
  })
  requestId?: string;
}
