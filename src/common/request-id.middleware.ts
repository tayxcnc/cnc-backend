import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './request-context';

/** The header read on the way in and written on the way out. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * An id is at most this long and holds only these characters.
 *
 * The header is caller-controlled and it ends up in every log line for the
 * request and in the error body. Both of those are places where unbounded
 * attacker-controlled text is a problem: a megabyte of header would be written
 * to Cloud Logging on every request, and control characters would let a caller
 * forge what looks like a second log entry. A UUID is 36 characters; 128 is
 * generous for a caller's own tracing id and still bounded.
 */
const ACCEPTABLE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Give every request an id, on the response and in its logs.
 *
 * ## Why the caller's id is honoured
 *
 * Cloud Run does not send `X-Request-Id`, so today every id is generated here.
 * A load balancer or an API gateway in front of the service might, and when
 * one does, honouring it is what lets a single identifier span both systems.
 * That is the whole point of the header.
 *
 * The id is validated rather than trusted. See ACCEPTABLE_ID: an id that does
 * not match is discarded and a generated one is used instead, silently,
 * because a caller sending a malformed tracing header is not an error the
 * caller can act on.
 *
 * ## Why it is first in the chain
 *
 * Everything after it — the body parser, helmet, CORS, the guards, the
 * handler, and the exception filter — runs inside the store this opens. A
 * request that fails in the body parser still has an id, which is precisely
 * the request you cannot otherwise find.
 *
 * ## Why the header is set before `next()`
 *
 * Express sends the headers the moment the first byte of the body is written.
 * Setting it afterwards would be too late for any response that streams, and
 * silently too late rather than an error.
 */
export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const supplied = request.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(supplied) ? supplied[0] : supplied;

  const requestId =
    typeof candidate === 'string' && ACCEPTABLE_ID.test(candidate)
      ? candidate
      : randomUUID();

  response.setHeader(REQUEST_ID_HEADER, requestId);

  runWithRequestContext({ requestId }, () => {
    next();
  });
}
