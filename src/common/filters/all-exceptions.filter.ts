import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { Response } from 'express';
import { isPrismaErrorCode } from '../../prisma/prisma-error';
import { currentRequestId } from '../request-context';

/**
 * The one place an error becomes a response body.
 *
 * ## What it fixes
 *
 * Without a filter of its own, Nest uses its built-in `BaseExceptionFilter`.
 * That filter decides whether an unknown throw is "really" an HTTP error with
 * a **duck-type check** — anything carrying both a `statusCode` and a
 * `message` property — and when it matches it echoes that object's own
 * `message` straight to the caller with its own status.
 *
 * Nothing in this codebase throws such an object deliberately. A third-party
 * client, a database driver or a `http-errors` instance from a transitive
 * dependency can be shaped exactly that way, and its message is written for a
 * developer reading a stack trace, not for a customer or a cashier reading a
 * screen. That is the one realistic leak path in 500 handling.
 *
 * So: a real `HttpException` passes through untouched, and **everything else**
 * becomes the generic 500, including anything that merely looks like an HTTP
 * error.
 *
 * ## Why 4xx bodies are preserved exactly
 *
 * Every deliberate refusal in this service is an `HttpException` with wording
 * somebody chose, and the screens show that wording verbatim (plan A7): the
 * stale-write "This record changed. Refresh and try again.", the
 * enumeration-safe sign-in message that must stay identical for a wrong
 * password and an unknown address. Rewriting any of those here would be a
 * behaviour change hidden in an error handler, and the e2e suites assert many
 * of them verbatim. The only addition is `requestId`.
 *
 * ## Why the id is added to 4xx as well as 5xx
 *
 * A customer or a staff member who is refused can quote it. Without it, "it
 * wouldn't let me settle the bill" is unfindable in the same way "it broke at
 * about four" is.
 *
 * ## What it never reads
 *
 * The request. It never records request headers — a cookie above all, since
 * browsers also send other `tayxcnc.com` services' cookies here (plan A16).
 */
/**
 * The status at and above which a failure is the server's fault.
 *
 * A plain number rather than `HttpStatus.INTERNAL_SERVER_ERROR` because
 * `getStatus()` returns a number and comparing a number against an enum member
 * is what `no-unsafe-enum-comparison` exists to catch.
 */
const SERVER_ERROR_FLOOR = 500;

/** The bottom of the client-fault range. */
const CLIENT_ERROR_FLOOR = 400;

/**
 * A platform-level client fault, recognised narrowly.
 *
 * ## The problem this solves
 *
 * Express's body parser refuses a body over 100 kb, and malformed JSON, by
 * throwing an `http-errors` instance — not a Nest `HttpException`. The rule
 * above sends everything that is not an `HttpException` to the generic 500, so
 * without this an oversized body to the payment webhook would be answered
 * **500**, where Nest's built-in filter answers 413, and a caller's malformed
 * JSON would become a server error too.
 *
 * That is worse than untidy. It makes the 5xx rate — which alerting watches —
 * something any caller can raise at will with a large POST, and it tells a
 * client that its own bad request was this service's fault.
 *
 * ## Why this is not the leak the filter exists to stop
 *
 * The duck-type check the filter replaces accepts **anything** carrying a
 * `statusCode` and a `message`, which is the shape a Postgres driver error
 * also has — that is the leak, and it stays closed. This check is narrower in
 * two ways that a database error cannot satisfy: it requires `expose === true`,
 * which is `http-errors`' own marker for "this was the caller's fault and
 * saying so is safe", and it requires the status to be in the 4xx range.
 *
 * And it still does not echo the message. Only the status survives; the body
 * carries the standard reason phrase for that status, which is a constant from
 * Node rather than anything the request influenced.
 */
function clientFaultStatusOf(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;

  const candidate = exception as { status?: unknown; expose?: unknown };

  if (candidate.expose !== true) return undefined;
  if (typeof candidate.status !== 'number') return undefined;

  return candidate.status >= CLIENT_ERROR_FLOOR &&
    candidate.status < SERVER_ERROR_FLOOR
    ? candidate.status
    : undefined;
}

/**
 * The answer when the database could not take the request in time (card
 * C8-4). New: the demo had no server to be busy.
 */
export const DATABASE_BUSY_MESSAGE =
  'CNC is busy right now. Wait a moment and try again.';

/** Seconds a caller is told to wait after {@link DATABASE_BUSY_MESSAGE}. */
export const DATABASE_BUSY_RETRY_AFTER_S = 2;

/**
 * Prisma's two "not in time" errors, both of which leave nothing written:
 * P2024, no connection came free from the pool in time, and P2028, an
 * interactive transaction that could not start within its wait or ran past
 * its timeout (Prisma rolls it back). Found by the C8-4 load test: while the
 * database was slow, every such request answered the generic 500, which
 * tells a cashier nothing and a client nothing it can act on. Nothing was
 * committed, and every money and booking write carries an Idempotency-Key,
 * so trying again is safe: 503 with `Retry-After`.
 *
 * The driver adapter also lets `pg`'s own pool error through unwrapped
 * when a query outside a transaction waits longer than the pool's connect
 * timeout (5 s) for a connection: the query never ran. It is matched by
 * `pg-pool`'s exact message, the only mark it carries.
 */
export const PG_POOL_TIMEOUT_MESSAGE =
  'timeout exceeded when trying to connect';

function isDatabaseBusy(exception: unknown): boolean {
  return (
    isPrismaErrorCode(exception, 'P2024') ||
    isPrismaErrorCode(exception, 'P2028') ||
    (exception instanceof Error &&
      exception.message === PG_POOL_TIMEOUT_MESSAGE)
  );
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    // Only the response is taken: request headers (cookies) are never read,
    // logged or echoed here.
    const response = http.getResponse<Response>();

    // Not an HTTP request at all — a lifecycle hook, or a future queue
    // consumer. There is no response to write, and swallowing it silently is
    // worse than a log line nobody reads.
    if (typeof response?.status !== 'function') {
      this.logger.error(exception);
      return;
    }

    const requestId = currentRequestId();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // A string response is what `new BadRequestException('…')` produces
      // before Nest expands it; an object is what the ValidationPipe and every
      // explicit body produce. Both keep their shape, gaining one field.
      const payload: Record<string, unknown> =
        typeof body === 'string'
          ? { statusCode: status, message: body }
          : { ...(body as Record<string, unknown>) };

      if (requestId !== undefined) payload.requestId = requestId;

      // 5xx thrown deliberately is still a server fault worth a stack. 4xx is
      // the service working correctly and is not logged here; the routes that
      // care log their own refusals with their own wording.
      if (status >= SERVER_ERROR_FLOOR) {
        this.logger.error(exception);
      }

      response.status(status).json(payload);
      return;
    }

    // A platform-level client fault: an oversized body, malformed JSON. Its
    // status is the caller's answer; its message is not. See above.
    const clientFault = clientFaultStatusOf(exception);

    if (clientFault !== undefined) {
      const payload: Record<string, unknown> = {
        statusCode: clientFault,
        message: STATUS_CODES[clientFault] ?? 'Request rejected',
      };

      if (requestId !== undefined) payload.requestId = requestId;

      // Not logged as an error. This is the service working: a caller sent
      // something it should not have and was told so.
      response.status(clientFault).json(payload);
      return;
    }

    // The database could not take the request in time; nothing was written.
    // One warning line with the code, never Prisma's message (it can name
    // the query).
    if (isDatabaseBusy(exception)) {
      const code = (exception as { code?: unknown }).code;

      this.logger.warn(
        `Database busy (${typeof code === 'string' ? code : 'pool timeout'}): answered 503.`,
      );

      const payload: Record<string, unknown> = {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: DATABASE_BUSY_MESSAGE,
      };

      if (requestId !== undefined) payload.requestId = requestId;

      response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .setHeader('Retry-After', String(DATABASE_BUSY_RETRY_AFTER_S))
        .json(payload);
      return;
    }

    // Everything else. The exception goes to the log in full — the structured
    // logger attaches the same requestId — and the caller gets three fields.
    this.logger.error(exception);

    const payload: Record<string, unknown> = {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };

    if (requestId !== undefined) payload.requestId = requestId;

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(payload);
  }
}
