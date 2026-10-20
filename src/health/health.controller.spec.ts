import type { Response } from 'express';
import { runWithRequestContext } from '../common/request-context';
import type {
  DatabaseHealth,
  DatabaseHealthProbe,
} from './database-health.token';
import { HealthController } from './health.controller';
import type { RedisHealth, RedisHealthProbe } from './redis-health.token';

/**
 * The two probes, without Nest or a database: the controller is constructed
 * directly with fakes, which is all its DI amounts to.
 */
function fakeResponse(): { response: Response; status: () => number } {
  let code = 200;
  const response = {
    status(next: number) {
      code = next;
      return response;
    },
  } as unknown as Response;

  return { response, status: () => code };
}

const database = (answer: DatabaseHealth): DatabaseHealthProbe => ({
  probeDatabase: () => Promise.resolve(answer),
});

const redis = (answer: RedisHealth): RedisHealthProbe => ({
  probeRedis: () => Promise.resolve(answer),
});

describe('HealthController', () => {
  describe('GET /health', () => {
    it('answers ok with the injected service name and no probes wired', async () => {
      const body = await new HealthController('cnc').check();

      expect(body).toMatchObject({
        status: 'ok',
        service: 'cnc',
        redis: 'unconfigured',
      });
      expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    });

    it('reports Redis without letting it decide anything', async () => {
      const body = await new HealthController(
        'cnc',
        redis('unavailable'),
      ).check();

      expect(body.status).toBe('ok');
      expect(body.redis).toBe('unavailable');
    });

    it('never asks the database', async () => {
      const probeDatabase = jest.fn<Promise<DatabaseHealth>, []>();

      await new HealthController('cnc', undefined, { probeDatabase }).check();

      expect(probeDatabase).not.toHaveBeenCalled();
    });
  });

  describe('GET /health/ready', () => {
    it('is ready with 200 when the database answers', async () => {
      const { response, status } = fakeResponse();
      const body = await new HealthController(
        'cnc',
        undefined,
        database('ok'),
      ).ready(response);

      expect(status()).toBe(200);
      expect(body).toMatchObject({
        status: 'ready',
        database: 'ok',
        redis: 'unconfigured',
        service: 'cnc',
      });
      expect(body).not.toHaveProperty('requestId');
    });

    it('is not ready with 503, carrying the request id, when it does not', async () => {
      const { response, status } = fakeResponse();
      const controller = new HealthController(
        'cnc',
        undefined,
        database('unreachable'),
      );

      const body = await runWithRequestContext({ requestId: 'req-503' }, () =>
        controller.ready(response),
      );

      expect(status()).toBe(503);
      expect(body).toMatchObject({
        status: 'not-ready',
        database: 'unreachable',
        requestId: 'req-503',
      });
    });

    it('stays ready with no database probe wired, which is not a fault', async () => {
      const { response, status } = fakeResponse();
      const body = await new HealthController('cnc').ready(response);

      expect(status()).toBe(200);
      expect(body.database).toBe('unconfigured');
    });

    it('stays ready when only Redis is down', async () => {
      const { response, status } = fakeResponse();
      const body = await new HealthController(
        'cnc',
        redis('unavailable'),
        database('ok'),
      ).ready(response);

      expect(status()).toBe(200);
      expect(body.redis).toBe('unavailable');
    });
  });
});
