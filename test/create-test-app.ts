import { randomUUID } from 'node:crypto';
import { INestApplication, type Type, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';
import { CncAppModule } from '../src/app.module';
import {
  useCompression,
  useCors,
  useTrustedProxyHops,
  VALIDATION_PIPE_OPTIONS,
} from '../src/bootstrap';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { RATE_LIMIT_NAMESPACE } from '../src/common/throttler/rate-limit-store';
import { CncConfigService } from '../src/config/cnc.config';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport';
import { RecordingMailTransport } from '../src/mail/recording-mail-transport';
import { PAYSTACK_CLIENT } from '../src/payments/paystack-client';
import { PUSH_SENDER } from '../src/push/push-sender';
import { PUSH_PUBLIC_KEY } from '../src/push/push-subscriptions.service';
import { MediaStorage } from '../src/storage/media-storage';
import { FakeMediaStorage } from './fake-media-storage';
import { FakePaystackClient } from './fake-paystack-client';
import { RecordingPushSender } from './recording-push-sender';
import { testVapidTrio } from './vapid-test-pair';

/** The recording mail transport of an app `createTestApp` built. */
export function sentMail(app: INestApplication<App>): RecordingMailTransport {
  return app.get<RecordingMailTransport>(MAIL_TRANSPORT, { strict: false });
}

/** The recording push sender of an app `createTestApp` built (C10). */
export function pushSender(app: INestApplication<App>): RecordingPushSender {
  return app.get<RecordingPushSender>(PUSH_SENDER, { strict: false });
}

/**
 * A CNC application wired the way `bootstrap()` wires the real one.
 *
 * Built from the real root module against the real database, with the same
 * request-id middleware, proxy trust, global prefix, ValidationPipe,
 * response compression and CORS rule as the service, each imported from
 * `bootstrap.ts` rather than restated so the harness and the service cannot
 * drift apart.
 *
 * Helmet and Swagger are left out: neither changes a status code or a body.
 * Every third party is replaced by a fake here, so no suite ever reaches
 * one over the network: the media bucket (`MediaStorage`, an in-memory
 * `FakeMediaStorage`; read it back with
 * `app.get(MediaStorage, { strict: false })`) and, from C6, mail
 * (`MAIL_TRANSPORT`, a `RecordingMailTransport` that logs nothing, whatever
 * `CNC_ENV` says; read the messages with `sentMail(app)`) and, from C7,
 * Paystack (`PAYSTACK_CLIENT`, a `FakePaystackClient` that calls nobody;
 * read and steer it with `fakePaystack(app)`) and, from C10, web push
 * (`PUSH_SENDER`, a `RecordingPushSender` that reaches no push service;
 * read and steer it with `pushSender(app)`). The served push key
 * (`PUSH_PUBLIC_KEY`) is the test pair's (`testVapidTrio`), whatever the
 * local `.env` holds; `push: 'unconfigured'` serves none, as a service
 * without `CNC_VAPID_*` does.
 *
 * `controllers` adds test-only routes beside the real ones, for a suite that
 * proves a piece of shared infrastructure (optimistic versions, idempotency)
 * through HTTP before any real route uses it. They exist in that suite's app
 * only and never in the service.
 *
 * The rate limits are stored in the database (C8-3), so each app gets a
 * namespace of its own for its counts (`RATE_LIMIT_NAMESPACE`), as if it
 * were a deployment of its own: suites running side by side on the shared
 * database, and runs a few minutes apart, would otherwise spend each
 * other's counts and answer 429 for reasons no test chose. A suite proving
 * that two instances share one count passes the same `rateLimitNamespace`
 * to two apps.
 */
export async function createTestApp(
  options: {
    controllers?: Type<unknown>[];
    rateLimitNamespace?: string;
    push?: 'configured' | 'unconfigured';
  } = {},
): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [CncAppModule],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(RATE_LIMIT_NAMESPACE)
    .useValue(options.rateLimitNamespace ?? `test-${randomUUID()}`)
    .overrideProvider(MediaStorage)
    .useValue(new FakeMediaStorage())
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(new RecordingMailTransport(false))
    .overrideProvider(PAYSTACK_CLIENT)
    .useValue(new FakePaystackClient())
    .overrideProvider(PUSH_SENDER)
    .useValue(new RecordingPushSender())
    .overrideProvider(PUSH_PUBLIC_KEY)
    .useValue(
      options.push === 'unconfigured' ? null : testVapidTrio().publicKey,
    )
    .compile();

  // `rawBody` matches bootstrap(): the Paystack webhook (C7) authenticates by
  // an HMAC over the unparsed bytes.
  const app = moduleFixture.createNestApplication<INestApplication<App>>({
    rawBody: true,
  });

  // First in the chain, as in bootstrap(), so every request has an id and the
  // exception filter's body carries `requestId` exactly as in production.
  app.use(requestIdMiddleware);

  useTrustedProxyHops(app);

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));

  // As in bootstrap(), so every suite reads compressed answers the way a
  // browser does, and the Paystack webhook suites prove the signature is
  // still checked over the raw request bytes with compression on.
  useCompression(app);

  useCors(app, app.get(CncConfigService).corsOrigins);

  // `listen(0)` rather than `init()`, and this is a fix rather than a
  // preference, learned in TAY's backend. `init()` makes supertest bind an
  // ephemeral port per request; across parallel Jest workers ports are reused
  // fast enough that a keep-alive socket delivers a response to the wrong
  // request. Binding once per suite removes the churn; `close()` releases it.
  await app.listen(0);

  return app;
}
