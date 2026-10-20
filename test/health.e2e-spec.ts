import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp } from './create-test-app';

/**
 * Liveness and readiness against the real database.
 *
 * Readiness is what Cloud Run and the C1/C2 gates read: 200 only when the
 * database answers. Redis is not configured (plan A18), so it reads
 * `unconfigured` and does not decide anything.
 */
describe('health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health answers liveness for the cnc service', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);

    expect(response.body).toMatchObject({ status: 'ok', service: 'cnc' });
  });

  it('GET /api/v1/health/ready reports the database ready', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health/ready')
      .expect(200);

    expect(response.body).toMatchObject({
      status: 'ready',
      database: 'ok',
      redis: 'unconfigured',
      service: 'cnc',
    });
  });

  it('answers an unknown route with the standard error body and a request id', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/no-such-route')
      .expect(404);

    const body = response.body as { statusCode: number; requestId?: unknown };

    expect(body.statusCode).toBe(404);
    expect(typeof body.requestId).toBe('string');
    expect(response.headers['x-request-id']).toBe(body.requestId);
  });
});
