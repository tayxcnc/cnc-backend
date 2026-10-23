import { asRecord } from './payload-readers';

/**
 * The Paystack envelope, copied from TAY's `paystack-events.ts`. CNC acts
 * on `charge.success` only; every other event is acknowledged and logged.
 */
export const CHARGE_SUCCESS = 'charge.success';

/** The two fields Paystack's envelope always has. */
export interface PaystackEnvelope {
  event: string;
  data: Record<string, unknown>;
}

/** The parsed body as an envelope, or undefined without an `event`. */
export function asEnvelope(parsed: unknown): PaystackEnvelope | undefined {
  const body = asRecord(parsed);
  const event = body?.event;

  if (body === undefined || typeof event !== 'string' || event === '') {
    return undefined;
  }

  return { event, data: asRecord(body.data) ?? {} };
}

/** The transaction reference a payload carries, when it carries one. */
export function referenceOf(data: Record<string, unknown>): string | undefined {
  const direct = data.reference;

  return typeof direct === 'string' && direct !== '' ? direct : undefined;
}
