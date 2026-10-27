import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The error body this service returns for every failure, described once.
 *
 * Nothing throws this class — it exists so that `@ApiResponse` can name a type
 * for a failure the same way it names one for a success, instead of each
 * controller re-describing the same fields with an inline literal. Reference
 * it from every non-2xx `@ApiResponse` in the codebase.
 *
 * The shape is `AllExceptionsFilter`'s. That filter preserves Nest's three
 * fields exactly — every 4xx keeps the status, the wording and the shape
 * somebody chose for it — and adds one. This class is the single place the
 * documented shape changes.
 */
export class ApiErrorResponse {
  @ApiProperty({
    description: 'HTTP status code, repeated in the body by Nest.',
    example: 401,
  })
  statusCode!: number;

  @ApiProperty({
    description:
      'A single human-readable reason, or — when the global ValidationPipe ' +
      'rejects the request body — one string per failed constraint.',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: 'Invalid or expired access token.',
  })
  message!: string | string[];

  @ApiPropertyOptional({
    description:
      'The status code’s canonical reason phrase. Optional, and genuinely so: ' +
      'Nest omits it when an exception is thrown without a message, which is ' +
      'what Passport does on a missing or unverifiable bearer token — that ' +
      'response is `{ message: "Unauthorized", statusCode: 401 }` and nothing ' +
      'more. Documenting it as required would make Prism mock a field the ' +
      'real service does not always send.',
    example: 'Unauthorized',
  })
  error?: string;

  @ApiPropertyOptional({
    description:
      'The id of the request that produced this error, also on the ' +
      '`X-Request-Id` response header. Quote it and the exact log line can ' +
      'be found. Present on every error the service produces; optional only ' +
      'because a response written before the middleware runs cannot carry ' +
      'one, and because an invented id would look findable and never be ' +
      'found.',
    example: '9f1c2f1e-2f3a-4c8b-9a1e-7d5c3b2a1098',
  })
  requestId?: string;
}
