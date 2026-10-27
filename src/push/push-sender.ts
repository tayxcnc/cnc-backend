import { Logger } from '@nestjs/common';
import {
  sendNotification,
  setVapidDetails,
  type Urgency,
  WebPushError,
} from 'web-push';
import type { CncConfigService } from '../config/cnc.config';
import { pushEndpointProblem } from './push-hosts';

/**
 * The one file that imports `web-push` (C10), copied from TAY's
 * `push-sender.ts` and adapted.
 *
 * Pinned at 3.6.7, the last CommonJS release: the next is ESM-only, and
 * Jest's CommonJS runtime cannot load it. Unit tests mock `web-push`; the
 * e2e harness binds `RecordingPushSender` to `PUSH_SENDER`. Nothing sends a
 * real push from a test.
 *
 * Signs with the pair from `CncConfigService.vapid()`. Where that is null
 * (local, with no keys) the provider binds `DisabledPushSender`, every send
 * is SKIPPED, and the queue leaves the row waiting.
 *
 * **Never logs an endpoint or a key**: the endpoint identifies a person's
 * device. Log lines carry the queued push's id.
 */

/** The DI token every reader of the sender injects. */
export const PUSH_SENDER = Symbol('PUSH_SENDER');

/** What one send came to, for one subscription. */
export type PushOutcome =
  /** The push service accepted it. */
  | 'SENT'
  /** 404 or 410: the subscription is dead. Delete it. */
  | 'GONE'
  /**
   * 401 or 403: the push service refused the signature, so the
   * subscription was made with another key (D12). Delete it; the device
   * subscribes again with the current key on its next visit.
   */
  | 'KEY_MISMATCH'
  /** 400, 413, too large, or an endpoint off the list: never retried. */
  | 'REJECTED'
  /** 429, 5xx, a timeout or no answer: worth trying again later. */
  | 'RETRY'
  /** Push is not configured here. */
  | 'SKIPPED';

/** The three values a browser's subscription gives the server. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the service worker receives (`PushMessage`'s columns). Under 3 KB. */
export interface PushPayload {
  /** The `PushMessage` id: a repeated delivery is recognised by it. */
  id: string;
  title: string;
  body: string;
  /** A site path without `/cnc` (customer) or `/#page` (staff), or null. */
  link: string | null;
  /** The staff app's hand-off ref, never shown; null for a customer. */
  ref: string | null;
  tag: string;
  urgent: boolean;
  renotify: boolean;
}

export interface PushOptions {
  /** How long the push service keeps it for an offline device. */
  ttlSeconds: number;
  urgency: Urgency;
  /** Socket timeout for this one request. */
  timeoutMs: number;
}

/** The encrypted payload limit is 4 KB; 3 KB of JSON leaves room for it. */
export const MAX_PAYLOAD_BYTES = 3 * 1024;

/** What sends a push. Bound by `PUSH_SENDER`. */
export interface PushSender {
  /** Whether a send can do anything at all. */
  readonly isConfigured: boolean;
  send(
    target: PushTarget,
    payload: PushPayload,
    options: PushOptions,
  ): Promise<PushOutcome>;
}

/** The sender where no pair is configured (local): every send is SKIPPED. */
export class DisabledPushSender implements PushSender {
  readonly isConfigured = false;

  send(): Promise<PushOutcome> {
    return Promise.resolve('SKIPPED');
  }
}

/** The real sender: signs with the VAPID pair and posts to the push service. */
export class WebPushSender implements PushSender {
  private readonly logger = new Logger(WebPushSender.name);

  readonly isConfigured = true;

  constructor(vapid: {
    publicKey: string;
    privateKey: string;
    subject: string;
  }) {
    setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  async send(
    target: PushTarget,
    payload: PushPayload,
    options: PushOptions,
  ): Promise<PushOutcome> {
    // Again here, not only at subscribe (D13): a row stored before a host
    // left the list must never be contacted.
    if (pushEndpointProblem(target.endpoint) !== null) {
      this.logger.warn(
        `Push ${payload.id} refused: a subscription names no known push ` +
          'service.',
      );
      return 'REJECTED';
    }

    const body = JSON.stringify(payload);

    if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
      // The catalogue caps every column, so this means a payload nobody
      // wrote through it. Refused here, not by the push service.
      this.logger.error(`Push ${payload.id} is over 3 KB.`);
      return 'REJECTED';
    }

    try {
      await sendNotification(
        {
          endpoint: target.endpoint,
          keys: { p256dh: target.p256dh, auth: target.auth },
        },
        body,
        {
          TTL: options.ttlSeconds,
          urgency: options.urgency,
          timeout: options.timeoutMs,
        },
      );

      return 'SENT';
    } catch (error) {
      if (error instanceof WebPushError) {
        return outcomeOf(error.statusCode);
      }

      // No status at all: DNS, TLS, a timeout. The error is not logged: its
      // message can carry the endpoint.
      return 'RETRY';
    }
  }
}

/** The outcome a push service's status code means. */
export function outcomeOf(statusCode: number): PushOutcome {
  if (statusCode === 404 || statusCode === 410) return 'GONE';
  if (statusCode === 401 || statusCode === 403) return 'KEY_MISMATCH';
  if (statusCode === 400 || statusCode === 413) return 'REJECTED';
  if (statusCode >= 200 && statusCode < 300) return 'SENT';

  return 'RETRY';
}

/**
 * The process's one sender (`PushModule`'s factory): the real one where
 * `CNC_VAPID_*` is configured, the disabled one otherwise.
 */
export function pushSenderFor(
  config: Pick<CncConfigService, 'vapid'>,
): PushSender {
  const vapid = config.vapid();

  return vapid === null ? new DisabledPushSender() : new WebPushSender(vapid);
}
