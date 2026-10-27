import { Logger } from '@nestjs/common';
import {
  DisabledPushSender,
  MAX_PAYLOAD_BYTES,
  outcomeOf,
  pushSenderFor,
  WebPushSender,
} from './push-sender';

/**
 * C10, ported from TAY's `push-sender.spec.ts`. `web-push` is replaced
 * wholesale: the real module is never loaded in Jest, and nothing here
 * reaches a push service.
 */
jest.mock('web-push', () => {
  class WebPushError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
    ) {
      super(message);
    }
  }

  return {
    WebPushError,
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const webPush = require('web-push') as {
  WebPushError: new (message: string, statusCode: number) => Error;
  setVapidDetails: jest.Mock;
  sendNotification: jest.Mock;
};

const VAPID = {
  publicKey: Buffer.alloc(65, 4).toString('base64url'),
  privateKey: Buffer.alloc(32, 7).toString('base64url'),
  subject: 'mailto:chefnoroculinarycnc@gmail.com',
};

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-abc';
const TARGET = { endpoint: ENDPOINT, p256dh: 'p', auth: 'a' };
const PAYLOAD = {
  id: 'push1',
  title: 'Order WEB-000124 is ready for pickup',
  body: 'Come to the counter to collect it.',
  link: '/account#order/WEB-000124',
  ref: null,
  tag: 'order:o1',
  urgent: true,
  renotify: true,
};
const OPTIONS = { ttlSeconds: 60, urgency: 'high' as const, timeoutMs: 1000 };

let logged: string[];

beforeEach(() => {
  logged = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
  }
});

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('WebPushSender (C10)', () => {
  it('maps the push service’s answer: 404 and 410 GONE, 401 and 403 KEY_MISMATCH, 400 and 413 REJECTED, 429 and 5xx RETRY', () => {
    expect(outcomeOf(201)).toBe('SENT');
    expect(outcomeOf(404)).toBe('GONE');
    expect(outcomeOf(410)).toBe('GONE');
    expect(outcomeOf(401)).toBe('KEY_MISMATCH');
    expect(outcomeOf(403)).toBe('KEY_MISMATCH');
    expect(outcomeOf(400)).toBe('REJECTED');
    expect(outcomeOf(413)).toBe('REJECTED');
    expect(outcomeOf(429)).toBe('RETRY');
    expect(outcomeOf(500)).toBe('RETRY');
    expect(outcomeOf(503)).toBe('RETRY');
  });

  it('binds the disabled sender, which skips every send and never signs, when push is not configured', async () => {
    const sender = pushSenderFor({ vapid: () => null });

    expect(sender).toBeInstanceOf(DisabledPushSender);
    expect(sender.isConfigured).toBe(false);
    expect(await sender.send(TARGET, PAYLOAD, OPTIONS)).toBe('SKIPPED');
    expect(webPush.setVapidDetails).not.toHaveBeenCalled();
    expect(webPush.sendNotification).not.toHaveBeenCalled();
  });

  it('signs once with the configured pair, and sends the payload as JSON with the TTL, urgency and timeout', async () => {
    webPush.sendNotification.mockResolvedValue({ statusCode: 201 });
    const sender = pushSenderFor({ vapid: () => VAPID });

    expect(sender).toBeInstanceOf(WebPushSender);
    expect(sender.isConfigured).toBe(true);
    expect(await sender.send(TARGET, PAYLOAD, OPTIONS)).toBe('SENT');
    expect(await sender.send(TARGET, PAYLOAD, OPTIONS)).toBe('SENT');
    expect(webPush.setVapidDetails).toHaveBeenCalledTimes(1);
    expect(webPush.setVapidDetails).toHaveBeenCalledWith(
      VAPID.subject,
      VAPID.publicKey,
      VAPID.privateKey,
    );
    expect(webPush.sendNotification).toHaveBeenCalledWith(
      { endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } },
      JSON.stringify(PAYLOAD),
      { TTL: 60, urgency: 'high', timeout: 1000 },
    );
  });

  it('answers GONE for a 410, KEY_MISMATCH for a 403, and RETRY for a failure with no status', async () => {
    const sender = new WebPushSender(VAPID);

    webPush.sendNotification.mockRejectedValueOnce(
      new webPush.WebPushError('gone', 410),
    );
    expect(await sender.send(TARGET, PAYLOAD, OPTIONS)).toBe('GONE');

    webPush.sendNotification.mockRejectedValueOnce(
      new webPush.WebPushError('forbidden', 403),
    );
    expect(await sender.send(TARGET, PAYLOAD, OPTIONS)).toBe('KEY_MISMATCH');

    webPush.sendNotification.mockRejectedValueOnce(
      new Error(`ETIMEDOUT ${ENDPOINT}`),
    );
    expect(await sender.send(TARGET, PAYLOAD, OPTIONS)).toBe('RETRY');
  });

  it('refuses a payload over 3 KB without sending it', async () => {
    const sender = new WebPushSender(VAPID);

    expect(
      await sender.send(
        TARGET,
        { ...PAYLOAD, link: `/account#${'x'.repeat(MAX_PAYLOAD_BYTES)}` },
        OPTIONS,
      ),
    ).toBe('REJECTED');
    expect(webPush.sendNotification).not.toHaveBeenCalled();
  });

  it('refuses a stored endpoint off the push-service list without calling the push service', async () => {
    const sender = new WebPushSender(VAPID);

    for (const endpoint of [
      'https://169.254.169.254/latest/meta-data',
      'https://evil.example/device-secret',
      'http://fcm.googleapis.com/fcm/send/x',
    ]) {
      expect(await sender.send({ ...TARGET, endpoint }, PAYLOAD, OPTIONS)).toBe(
        'REJECTED',
      );
    }
    expect(webPush.sendNotification).not.toHaveBeenCalled();
  });

  it('never logs an endpoint or a key, whatever the outcome', async () => {
    const sender = new WebPushSender(VAPID);

    webPush.sendNotification.mockRejectedValueOnce(
      new Error(`connect ECONNREFUSED ${ENDPOINT}`),
    );
    await sender.send(TARGET, PAYLOAD, OPTIONS);
    await sender.send(
      { ...TARGET, endpoint: 'https://evil.example/device-secret' },
      PAYLOAD,
      OPTIONS,
    );
    await sender.send(
      TARGET,
      { ...PAYLOAD, link: `/account#${'x'.repeat(MAX_PAYLOAD_BYTES)}` },
      OPTIONS,
    );

    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain('device-abc');
      expect(line).not.toContain('device-secret');
      expect(line).not.toContain(VAPID.privateKey);
    }
  });
});
