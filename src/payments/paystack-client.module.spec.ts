import { HttpPaystackClient } from './http-paystack-client';
import { LocalPaystackClient } from './local-paystack-client';
import { paystackClientFor } from './paystack-client.module';

describe('paystackClientFor (which Paystack client a run binds)', () => {
  const config = (
    cncEnv: 'local' | 'staging' | 'production',
    paystackLocalTestMode = false,
  ) => ({ cncEnv, paystackKey: 'sk_test_x', paystackLocalTestMode });

  it('calls nobody on a local run by default', () => {
    expect(paystackClientFor(config('local'))).toBeInstanceOf(
      LocalPaystackClient,
    );
  });

  it('calls Paystack’s test mode on a local run switched to test', () => {
    expect(paystackClientFor(config('local', true))).toBeInstanceOf(
      HttpPaystackClient,
    );
  });

  it('always calls Paystack on staging and production', () => {
    for (const env of ['staging', 'production'] as const) {
      expect(paystackClientFor(config(env))).toBeInstanceOf(HttpPaystackClient);
    }
  });
});
