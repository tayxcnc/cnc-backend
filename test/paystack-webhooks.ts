import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { signPaystackBody } from '../src/payments/webhook-signature';
import { fakePaystack } from './fake-paystack-client';

/**
 * Paystack's webhook as the e2e suites send it: bodies shaped as Paystack
 * sends them, signed with the suite's test key. Shared by the checkout and
 * the online order suites, so a change to the envelope is made once.
 */

/** A `charge.success` body for a reference and amount (kobo). */
export function chargeSuccessBody(
  reference: string,
  amount: number,
  over: Record<string, unknown> = {},
) {
  return {
    event: 'charge.success',
    data: {
      id: Math.floor(Math.random() * 1e9),
      status: 'success',
      reference,
      amount,
      currency: 'NGN',
      paid_at: new Date().toISOString(),
      channel: 'card',
      authorization: { card_type: 'visa ', last4: '4081', bin: '408408' },
      ...over,
    },
  };
}

/**
 * Post a webhook body signed as Paystack signs it. Paystack sends a
 * `charge.success` only for a transaction that was paid, so the fake's
 * verify is told the customer paid first.
 */
export function postSignedWebhook(
  app: INestApplication<App>,
  body: unknown,
  key: string,
) {
  const raw = JSON.stringify(body);
  const sent = body as { event?: unknown; data?: { reference?: unknown } };

  if (
    sent.event === 'charge.success' &&
    typeof sent.data?.reference === 'string'
  ) {
    fakePaystack(app).pay(sent.data.reference);
  }

  return request(app.getHttpServer())
    .post('/api/v1/payments/webhook')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', signPaystackBody(raw, key))
    .send(raw);
}
