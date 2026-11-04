import {
  INestApplication,
  Logger,
  ValidationPipe,
  type ValidationPipeOptions,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import helmet from 'helmet';
import { CncAppModule } from './app.module';
import { StructuredLogger } from './common/logging/structured-logger';
import { requestIdMiddleware } from './common/request-id.middleware';
import { CncConfigService } from './config/cnc.config';
import { setupCncSwagger } from './cnc-swagger';

/**
 * The one ValidationPipe configuration, shared by the running service and by
 * the e2e test harness.
 *
 * `whitelist` strips undeclared properties, `forbidNonWhitelisted` turns them
 * into a 400 instead, and `transform` runs class-transformer so DTO
 * `@Transform` decorators (email normalisation, trimming) actually execute.
 * Exported so the harness imports this object rather than restating three
 * booleans that would then drift.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
};

/**
 * How many hops at the END of the forwarding chain belong to the platform.
 *
 * Express builds the chain as `[socket peer, ...X-Forwarded-For reversed]` and
 * `req.ip` becomes the first entry that is NOT trusted. On Cloud Run the peer
 * is Google's front end and the header arrives as `<client>, <front end>`, so
 * two trusted hops land `req.ip` on the address Google observed the connection
 * coming from. That is the same hop `clientAddressOf` picks by reading the
 * header directly (second from last): the address a rate limit counts against
 * and the address `req.ip` reports must not be two different ideas of who the
 * caller is.
 *
 * A number and not `true`: `trust proxy: true` trusts whatever the caller put
 * at the front of the chain, so a caller sending their own
 * `X-Forwarded-For: 1.2.3.4` would BE 1.2.3.4, with a fresh address per
 * request. That is a rate limit that counts nothing and an audit log that
 * records fiction.
 */
export const TRUSTED_PROXY_HOPS = 2;

/**
 * The HTTP methods a browser on an allowed origin may use.
 *
 * **Every method a route uses must be here**, or the browser's preflight is
 * refused and the call never reaches the API, while every test that calls the
 * API directly still passes. TAY's backend shipped its first PUT route with
 * PUT missing and found out on staging. `test/cors.e2e-spec.ts` reads every
 * documented route and fails on a method not listed.
 */
export const CORS_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

/**
 * The request headers a browser on an allowed origin may send.
 *
 * `Idempotency-Key` is CNC's addition to TAY's list: order creation, payments,
 * web checkout and reservations carry it (plan A9), and a header missing here
 * fails the same way a missing method does, at the preflight, in a browser
 * only. `test/cors.e2e-spec.ts` preflights it.
 */
export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'Idempotency-Key',
] as const;

/**
 * The response headers a page on an allowed origin may read beyond the
 * safelisted ones: `Retry-After`, which every 429 of a rate limit carries
 * (C8-3), so a screen can say how long to wait.
 */
export const CORS_EXPOSED_HEADERS = ['Retry-After'] as const;

/**
 * Compress responses for a client that asks (Brotli or gzip, by its
 * `Accept-Encoding`), above the package's 1 KB floor (B2: the menu list is
 * about 39 KB as JSON and under 4 KB compressed).
 *
 * Responses only: a request body is never touched, so the Paystack
 * webhook's signature is still checked over the exact bytes Paystack sent
 * (`rawBody`). Images are left alone (already compressed), and Express's
 * `ETag` is computed before compression, so a conditional request still
 * answers 304. A function, so that `bootstrap()` and the e2e harness
 * compress identically.
 */
export function useCompression(app: INestApplication): void {
  app.use(compression());
}

/** The one method this needs from the Express instance under the adapter. */
interface SettableApp {
  set(setting: string, value: unknown): void;
}

/**
 * Apply {@link TRUSTED_PROXY_HOPS} to an application.
 *
 * A function so that `bootstrap()` and the e2e harness configure it
 * identically: a harness that trusted a different number of hops would count
 * rate limits against addresses the running service never sees.
 */
export function useTrustedProxyHops(app: INestApplication): void {
  const instance = app.getHttpAdapter().getInstance() as SettableApp;

  instance.set('trust proxy', TRUSTED_PROXY_HOPS);
}

/**
 * Exact-match CORS for the configured origins, credentials on.
 *
 * Split out of `bootstrap()` so the e2e harness applies the very same rule.
 *
 * The list comes from `CncConfigService` (`CNC_CORS_ORIGINS`), never from the
 * environment directly. TAY's bootstrap read an unprefixed `CORS_ORIGINS`
 * itself; CNC reads no unprefixed setting, and a copied read would have found
 * an empty list and refused every browser while staying healthy.
 *
 * Every accepted origin is one somebody wrote down. There is no pattern, on
 * any environment (see `main.ts`).
 */
export function useCors(
  app: INestApplication,
  allowedOrigins: readonly string[],
): void {
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      // Same-origin navigations, curl and server-to-server calls send no
      // Origin header at all. CORS has nothing to say about those.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);

      // Verbose, not warn. This URL is public, so unrecognised origins are
      // routine background traffic rather than an incident. The Origin header
      // is caller-controlled and unbounded, so only a plausible, short value
      // reaches the log; anything else is named, not echoed.
      const shown = /^[\x21-\x7e]{1,200}$/.test(origin)
        ? origin
        : '(malformed or oversized)';
      Logger.verbose(`CORS: origin not allowed: ${shown}`, 'Bootstrap');

      // No error. Passing one propagates to the exception filter and answers
      // 500, which on a public URL turns every drive-by origin scan into a
      // server error. Returning false omits Access-Control-Allow-Origin, and
      // the browser refuses to hand the response to the page.
      return callback(null, false);
    },
    methods: [...CORS_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    // `Retry-After` is not a header a page may read cross-origin unless it
    // is exposed; a refused request (429) carries it (C8-3).
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    // Needed for the httpOnly refresh cookie. Safe only because the origin
    // function above is an explicit allowlist. The pattern to refuse, if it
    // is ever proposed, is reflecting the request's own Origin back while
    // credentials are enabled: that makes every origin on the internet a
    // trusted one.
    credentials: true,
    maxAge: 86400,
  });
}

/**
 * Boot the CNC service.
 *
 * Reads no environment variable itself except through `CncConfigService`
 * (`PORT` and `NODE_ENV` included), so every setting this process honours is
 * visible in one file.
 */
export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(CncAppModule, {
    // Paystack signs webhook bodies over the raw bytes (C7). Re-serialising a
    // parsed body does not reliably reproduce what was signed. Nest's option
    // is per-application; body-parser already holds the buffer, so this keeps
    // a reference rather than a second copy, and the 100kb limit still holds.
    rawBody: true,
    // Buffered until useLogger below swaps in the real one, so the boot lines
    // come out in the same format as everything after them.
    bufferLogs: true,
  });

  const config = app.get(CncConfigService);

  // JSON when this is a built container, human-readable otherwise. NODE_ENV
  // answers whether a log aggregator or a person is reading stdout; which
  // deployment this is, is CNC_ENV's job.
  app.useLogger(new StructuredLogger(config.nodeEnv === 'production'));

  // First in the chain, so that a request failing anywhere still has an id.
  app.use(requestIdMiddleware);

  // Before anything reads an address.
  useTrustedProxyHops(app);

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

  app.use(helmet());

  // After helmet, so its headers are set before a body is compressed.
  useCompression(app);

  useCors(app, config.corsOrigins);

  await setupCncSwagger(app);

  await app.listen(config.port);

  Logger.log(
    `cnc service listening on port ${config.port} (prefix /api/v1)`,
    'Bootstrap',
  );
}
