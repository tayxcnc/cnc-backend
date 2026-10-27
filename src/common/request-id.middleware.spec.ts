import type { NextFunction, Request, Response } from 'express';
import { currentRequestId } from './request-context';
import {
  REQUEST_ID_HEADER,
  requestIdMiddleware,
} from './request-id.middleware';

function run(headers: Record<string, unknown>): {
  set: Record<string, string>;
  seenInside: string | undefined;
} {
  const set: Record<string, string> = {};
  let seenInside: string | undefined;

  const request = { headers } as unknown as Request;
  const response = {
    setHeader(name: string, value: string) {
      set[name] = value;
    },
  } as unknown as Response;

  const next: NextFunction = () => {
    seenInside = currentRequestId();
  };

  requestIdMiddleware(request, response, next);

  return { set, seenInside };
}

describe('requestIdMiddleware', () => {
  it('generates an id and sets it on the response', () => {
    const { set } = run({});

    expect(set[REQUEST_ID_HEADER]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('makes the same id readable inside the request', () => {
    const { set, seenInside } = run({});

    // The header and the log line have to agree, or quoting the id from a
    // response finds nothing.
    expect(seenInside).toBe(set[REQUEST_ID_HEADER]);
  });

  it("honours a caller's own id so one identifier spans both systems", () => {
    const { set, seenInside } = run({ [REQUEST_ID_HEADER]: 'gateway-abc-123' });

    expect(set[REQUEST_ID_HEADER]).toBe('gateway-abc-123');
    expect(seenInside).toBe('gateway-abc-123');
  });

  it.each([
    ['too long', 'x'.repeat(129)],
    ['a newline, which would forge a second log entry', 'abc\ndef'],
    ['a space', 'abc def'],
    ['empty', ''],
    ['angle brackets', '<script>'],
  ])(
    'discards a malformed id (%s) and generates one instead',
    (_name, supplied) => {
      const { set } = run({ [REQUEST_ID_HEADER]: supplied });

      expect(set[REQUEST_ID_HEADER]).not.toBe(supplied);
      expect(set[REQUEST_ID_HEADER]).toHaveLength(36);
    },
  );

  it('takes the first value when the header is repeated', () => {
    const { set } = run({ [REQUEST_ID_HEADER]: ['first-id', 'second-id'] });

    expect(set[REQUEST_ID_HEADER]).toBe('first-id');
  });

  it('reads as undefined outside any request', () => {
    // Bootstrap, a seed script, and anything a test calls directly. An
    // invented id would look findable in the logs and never be found.
    expect(currentRequestId()).toBeUndefined();
  });
});
