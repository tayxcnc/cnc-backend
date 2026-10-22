import { INestApplication, type Type, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';
import { CncAppModule } from '../src/app.module';
import {
  useCors,
  useTrustedProxyHops,
  VALIDATION_PIPE_OPTIONS,
} from '../src/bootstrap';
import { requestIdMiddleware } from '../src/common/request-id.middleware';
import { CncConfigService } from '../src/config/cnc.config';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport';
import { RecordingMailTransport } from '../src/mail/recording-mail-transport';
import { MediaStorage } from '../src/storage/media-storage';
import { FakeMediaStorage } from './fake-media-storage';

/** The recording mail transport of an app `createTestApp` built. */
export function sentMail(app: INestApplication<App>): RecordingMailTransport {
  return app.get<RecordingMailTransport>(MAIL_TRANSPORT, { strict: false });
}

/**
 * A CNC application wired the way `bootstrap()` wires the real one.
 *
 * Built from the real root module against the real database, with the same
 * request-id middleware, proxy trust, global prefix, ValidationPipe and CORS
 * rule as the service, each imported from `bootstrap.ts` rather than restated
 * so the harness and the service cannot drift apart.
 *
 * Helmet and Swagger are left out: neither changes a status code or a body.
 * Every third party is replaced by a fake here, so no suite ever reaches
 * one over the network: the media bucket (`MediaStorage`, an in-memory
 * `FakeMediaStorage`; read it back with
 * `app.get(MediaStorage, { strict: false })`) and, from C6, mail
 * (`MAIL_TRANSPORT`, a `RecordingMailTransport` that logs nothing, whatever
 * `CNC_ENV` says; read the messages with `sentMail(app)`). Paystack joins
 * them with its card.
 *
 * `controllers` adds test-only routes beside the real ones, for a suite that
 * proves a piece of shared infrastructure (optimistic versions, idempotency)
 * through HTTP before any real route uses it. They exist in that suite's app
 * only and never in the service.
 */
export async function createTestApp(
  options: { controllers?: Type<unknown>[] } = {},
): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [CncAppModule],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(MediaStorage)
    .useValue(new FakeMediaStorage())
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(new RecordingMailTransport(false))
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

  useCors(app, app.get(CncConfigService).corsOrigins);

  // `listen(0)` rather than `init()`, and this is a fix rather than a
  // preference, learned in TAY's backend. `init()` makes supertest bind an
  // ephemeral port per request; across parallel Jest workers ports are reused
  // fast enough that a keep-alive socket delivers a response to the wrong
  // request. Binding once per suite removes the churn; `close()` releases it.
  await app.listen(0);

  return app;
}
