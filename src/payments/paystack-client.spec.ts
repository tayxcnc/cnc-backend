import {
  PaystackRefusedError,
  PaystackUnavailableError,
  paystackNeverSawIt,
} from './paystack-client';

describe('paystackNeverSawIt (what a recheck may read as never paid)', () => {
  it('is Paystack’s 400 or 404 for a reference it does not know', () => {
    expect(
      paystackNeverSawIt(
        new PaystackRefusedError(400, 'Transaction reference not found'),
      ),
    ).toBe(true);
    expect(paystackNeverSawIt(new PaystackRefusedError(404, 'Not found'))).toBe(
      true,
    );
  });

  it('is never an outage, a rate limit, a refused key or a malformed answer', () => {
    for (const status of [500, 502, 503, 504, 429, 401, 403]) {
      expect(paystackNeverSawIt(new PaystackRefusedError(status, 'x'))).toBe(
        false,
      );
    }

    expect(paystackNeverSawIt(new PaystackUnavailableError())).toBe(false);
    expect(paystackNeverSawIt(new Error('boom'))).toBe(false);
  });
});
