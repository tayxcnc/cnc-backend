import { ApiProperty } from '@nestjs/swagger';
import type { RedisHealth } from '../redis-health.token';

/**
 * Body of GET /api/v1/health.
 *
 * A class rather than an interface because the generated Swagger document is
 * the contract, and an interface leaves nothing behind at runtime for
 * `@ApiResponse({ type })` to read.
 */
export class HealthResponse {
  @ApiProperty({
    description:
      'Always "ok". The probe answers "is the process up", so any other ' +
      'outcome is a non-200, not a different status string.',
    enum: ['ok'],
    example: 'ok',
  })
  status!: 'ok';

  @ApiProperty({
    description:
      'Which service answered. Injected at module level, never read from ' +
      'the environment, so a misconfigured container cannot make this ' +
      'service report itself as something else.',
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

  @ApiProperty({
    description:
      'Whether Redis answered. Informational, never fatal — the status above ' +
      'stays "ok" and the HTTP code stays 200 whatever this says. `ok`: ' +
      'connected and answered a PING. `unavailable`: configured but not ' +
      'reachable right now; rate limits are counting per instance in memory ' +
      'until it returns. `unconfigured`: no Redis for this process, which ' +
      'is the expected state at launch.',
    enum: ['ok', 'unavailable', 'unconfigured'],
    example: 'unconfigured',
  })
  redis!: RedisHealth;
}
