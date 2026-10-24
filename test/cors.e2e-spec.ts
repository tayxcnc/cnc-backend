import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { CORS_ALLOWED_HEADERS, CORS_METHODS } from '../src/bootstrap';
import { buildCncDocument } from '../src/cnc-swagger';
import { createTestApp } from './create-test-app';

/**
 * CORS lets a browser on an allowed origin use every method and every custom
 * header the API needs, and nothing reaches a page from any other origin.
 *
 * The rest of the e2e suite calls the API directly and sends no preflight, so
 * a method or header missing from the CORS lists passes every other test and
 * fails only in a browser. TAY's backend found exactly that on staging with
 * its first PUT route. CNC adds `Idempotency-Key` (plan A9), which is the same
 * failure waiting to happen, so it is preflighted here.
 */
describe('CORS (e2e)', () => {
  const ALLOWED = 'https://allowed.example';
  const OTHER = 'https://other.example';
  const originalOrigins = process.env.CNC_CORS_ORIGINS;
  let app: INestApplication<App>;

  beforeAll(async () => {
    // Read once, when the config service is constructed for this app.
    process.env.CNC_CORS_ORIGINS = ` ${ALLOWED} , https://second.example`;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    if (originalOrigins === undefined) delete process.env.CNC_CORS_ORIGINS;
    else process.env.CNC_CORS_ORIGINS = originalOrigins;
  });

  it('lists every documented route’s method', () => {
    const document = buildCncDocument(app);
    const used = new Set<string>();

    for (const operations of Object.values(document.paths)) {
      for (const method of Object.keys(operations)) {
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          used.add(method.toUpperCase());
        }
      }
    }

    const allowed: readonly string[] = CORS_METHODS;
    const missing = [...used].filter((method) => !allowed.includes(method));

    expect(missing).toEqual([]);
  });

  it('answers a preflight that carries Idempotency-Key from an allowed origin', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/health')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,idempotency-key');

    expect(response.status).toBeLessThan(300);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-credentials']).toBe('true');

    const allowedHeaders = String(
      response.headers['access-control-allow-headers'],
    )
      .toLowerCase()
      .split(',')
      .map((header) => header.trim());

    // Named here rather than read from CORS_ALLOWED_HEADERS: a test that
    // iterated the constant would still pass after the header was removed
    // from it, which is the one regression this test exists to catch.
    for (const header of ['content-type', 'authorization', 'idempotency-key']) {
      expect(allowedHeaders).toContain(header);
    }
    expect(CORS_ALLOWED_HEADERS.length).toBeGreaterThanOrEqual(3);
  });

  it('lets a page on an allowed origin read Retry-After (C8-3)', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', ALLOWED)
      .expect(200);

    // Named here for the reason the request headers are named above.
    expect(
      String(response.headers['access-control-expose-headers'])
        .toLowerCase()
        .split(',')
        .map((header) => header.trim()),
    ).toContain('retry-after');
  });

  it('trims the configured list, so an origin after a spaced comma matches', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'https://second.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(
      'https://second.example',
    );
  });

  it('gives any other origin no access header, without an error status', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', OTHER)
      .expect(200);

    // Refusal is the browser's job: no Access-Control-Allow-Origin means the
    // page never sees the response. The API does not answer 500 for it.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never reflects an unlisted origin, even on a preflight', async () => {
    const response = await request(app.getHttpServer())
      .options('/api/v1/health')
      .set('Origin', OTHER)
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
