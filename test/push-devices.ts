import { randomBytes, randomUUID } from 'node:crypto';
import type { CncPrismaService } from '../src/prisma/cnc-prisma.service';
import { testVapidTrio } from './vapid-test-pair';

/**
 * Push devices for the e2e suites (C10), so a suite writes one line per
 * device rather than the subscription's shape.
 *
 * Every endpoint is FCM's, the allowlist's first host, with a run-unique
 * path: a suite reads its own sends back by its prefix
 * (`pushSender(app).sentTo(prefix)`), whatever other suites send beside it.
 * The keys have the lengths a browser's have (65 and 16 bytes); nothing
 * encrypts with them, because `RecordingPushSender` sends nothing.
 */

/** A run-unique FCM endpoint prefix, for one suite or one test. */
export const fcmPrefix = (): string =>
  `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;

/** A browser's subscription, as `POST …/push/subscriptions` takes it. */
export function testSubscription(endpoint: string = `${fcmPrefix()}-device`) {
  const point = randomBytes(65);

  point[0] = 4;

  return {
    endpoint,
    keys: {
      p256dh: point.toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
    applicationServerKey: testVapidTrio().publicKey,
  };
}

/**
 * A device stored straight in the table, for a suite about events rather
 * than the subscribe route (which `push-routes` proves).
 */
export async function addDevice(
  prisma: CncPrismaService,
  owner: { customerId: string } | { staffId: string },
  endpoint: string = `${fcmPrefix()}-device`,
): Promise<string> {
  const { keys } = testSubscription(endpoint);
  const fields = { endpoint, p256dh: keys.p256dh, auth: keys.auth };

  if ('customerId' in owner) {
    await prisma.customerPushSubscription.create({
      data: { ...fields, customerId: owner.customerId },
    });
  } else {
    await prisma.staffPushSubscription.create({
      data: { ...fields, staffId: owner.staffId },
    });
  }

  return endpoint;
}
