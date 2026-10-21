import {
  applyDecorators,
  BadRequestException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { canonicalJsonHash } from '../common/canonical-json';
import { ApiErrorResponse } from '../common/dto/api-error.response';

/** The request header, as browsers send it (A9). In CORS `allowedHeaders`. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** The 400 for a missing or malformed key. */
export const IDEMPOTENCY_KEY_REQUIRED =
  'An Idempotency-Key header holding a UUID is required for this request.';

/** Any UUID, in its 8-4-4-4-12 hex form; the version is not checked. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a route hands `IdempotencyService.execute`, apart from the scope,
 * which comes from the authenticated caller.
 */
export interface IdempotencyRequest {
  /** The key, lower-cased, so one UUID in two cases is one key. */
  key: string;
  /** `METHOD /api/v1/path/:param`, the route's template, not the URL. */
  route: string;
  /**
   * SHA-256 of the request's route parameters, query and body, keys sorted
   * (`canonicalJsonHash`). The same key with a different request is refused,
   * so a client that reuses a key by mistake gets a 409 rather than the
   * answer to some other request.
   */
  requestHash: string;
}

/** The parts of an Express request this reads. */
type IdempotentHttpRequest = Pick<
  Request,
  'method' | 'params' | 'query' | 'body' | 'path'
> & {
  header(name: string): string | undefined;
  route?: { path?: unknown };
};

/**
 * Read and check the `Idempotency-Key` of a request, and fingerprint the
 * request. The body is the parsed JSON as the client sent it, before the
 * ValidationPipe transforms it, so the fingerprint is of what was sent.
 *
 * Throws 400 with {@link IDEMPOTENCY_KEY_REQUIRED} when the header is
 * missing or not a UUID: a write that takes money or a table without a key
 * is a write a retry can repeat (A9).
 */
export function readIdempotencyRequest(
  req: IdempotentHttpRequest,
): IdempotencyRequest {
  const raw = req.header(IDEMPOTENCY_KEY_HEADER);

  if (typeof raw !== 'string' || !UUID.test(raw.trim())) {
    throw new BadRequestException(IDEMPOTENCY_KEY_REQUIRED);
  }

  const template =
    typeof req.route?.path === 'string' ? req.route.path : req.path;

  return {
    key: raw.trim().toLowerCase(),
    route: `${req.method} ${template}`,
    requestHash: canonicalJsonHash({
      params: req.params ?? {},
      query: req.query ?? {},
      body: (req.body as unknown) ?? null,
    }),
  };
}

/**
 * The route parameter: `@IdempotencyKey() idem: IdempotencyRequest`.
 *
 * Runs after the guards, so an unauthenticated call is still a 401 rather
 * than a complaint about its header.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): IdempotencyRequest =>
    readIdempotencyRequest(
      context.switchToHttp().getRequest<IdempotentHttpRequest>(),
    ),
);

/**
 * Documents a route as taking `Idempotency-Key` (A9): the header and the 400
 * and 409 it can cause. Put it on every route that uses
 * {@link IdempotencyKey}; `test/idempotency.e2e-spec.ts` preflights every
 * route the API document shows with this header, so a route documented this
 * way is proved reachable from a browser (A9).
 */
export function IdempotentRoute(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiHeader({
      name: IDEMPOTENCY_KEY_HEADER,
      required: true,
      description:
        'A UUID the client generates once per intended action and resends ' +
        'unchanged on every retry of it. A repeat with the same key and the ' +
        'same request returns the first response; the same key with a ' +
        'different request is a 409.',
      schema: { type: 'string', format: 'uuid' },
    }),
    ApiBadRequestResponse({
      description: IDEMPOTENCY_KEY_REQUIRED,
      type: ApiErrorResponse,
    }),
    ApiConflictResponse({
      description:
        'The key was already used for a different request, or the record ' +
        'changed since it was read.',
      type: ApiErrorResponse,
    }),
  );
}
