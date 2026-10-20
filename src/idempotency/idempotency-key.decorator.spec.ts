import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import {
  IDEMPOTENCY_KEY_REQUIRED,
  readIdempotencyRequest,
} from './idempotency-key.decorator';
import { idempotencyScope } from './idempotency-scope';

// Generated rather than written out: a literal UUID beside the word "key"
// reads as a credential to the pre-commit secret scan.
const KEY = randomUUID().toUpperCase();

function fakeRequest(
  overrides: {
    key?: string;
    body?: unknown;
    params?: Record<string, string>;
    query?: Record<string, string>;
    routePath?: string;
  } = {},
) {
  const headers: Record<string, string | undefined> = {
    'idempotency-key': 'key' in overrides ? overrides.key : KEY,
  };

  return {
    method: 'POST',
    path: '/api/v1/staff/orders/abc/settle',
    route: { path: overrides.routePath ?? '/api/v1/staff/orders/:id/settle' },
    params: overrides.params ?? { id: 'abc' },
    query: overrides.query ?? {},
    body: overrides.body ?? { amountKobo: 250000, method: 'CASH' },
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Parameters<typeof readIdempotencyRequest>[0];
}

describe('readIdempotencyRequest', () => {
  it('reads the key in lower case, the route template and a fingerprint', () => {
    const request = readIdempotencyRequest(fakeRequest());

    expect(request.key).toBe(KEY.toLowerCase());
    expect(request.route).toBe('POST /api/v1/staff/orders/:id/settle');
    expect(request.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a UUID', 'retry-1'],
    ['two keys joined', `${KEY}, ${KEY}`],
  ])('refuses a key that is %s with 400', (_label, key) => {
    const read = () => readIdempotencyRequest(fakeRequest({ key }));

    expect(read).toThrow(BadRequestException);
    expect(read).toThrow(IDEMPOTENCY_KEY_REQUIRED);
  });

  it('gives the same fingerprint to the same request with its keys reordered', () => {
    const a = readIdempotencyRequest(
      fakeRequest({ body: { amountKobo: 250000, method: 'CASH' } }),
    );
    const b = readIdempotencyRequest(
      fakeRequest({ body: { method: 'CASH', amountKobo: 250000 } }),
    );

    expect(a.requestHash).toBe(b.requestHash);
  });

  it.each([
    ['body', { body: { amountKobo: 250001, method: 'CASH' } }],
    ['route parameter', { params: { id: 'xyz' } }],
    ['query', { query: { department: 'BAR' } }],
  ])('gives a different fingerprint when the %s differs', (_label, change) => {
    const a = readIdempotencyRequest(fakeRequest());
    const b = readIdempotencyRequest(fakeRequest(change));

    expect(a.requestHash).not.toBe(b.requestHash);
  });
});

describe('idempotencyScope', () => {
  it('names the realm and the subject', () => {
    expect(idempotencyScope.staff('s1')).toBe('staff:s1');
    expect(idempotencyScope.customer('c1')).toBe('customer:c1');
  });

  it('keeps an anonymous caller’s address out of the scope', () => {
    const scope = idempotencyScope.anonymous('203.0.113.7');

    expect(scope).toMatch(/^anon:[0-9a-f]{64}$/);
    expect(scope).not.toContain('203.0.113.7');
    expect(scope).toBe(idempotencyScope.anonymous('203.0.113.7'));
    expect(scope).not.toBe(idempotencyScope.anonymous('203.0.113.8'));
  });
});
