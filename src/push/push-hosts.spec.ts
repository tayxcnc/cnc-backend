import { PUSH_SERVICE_HOSTS, pushEndpointProblem } from './push-hosts';

/**
 * C10, D13: a subscription may only name a known push service, so the
 * service never POSTs to an address a signed-in person chose.
 */
describe('pushEndpointProblem', () => {
  it('lists the four push services', () => {
    expect(PUSH_SERVICE_HOSTS).toEqual({
      exact: ['fcm.googleapis.com', 'updates.push.services.mozilla.com'],
      suffixes: ['.push.apple.com', '.notify.windows.com'],
    });
  });

  it.each([
    'https://fcm.googleapis.com/fcm/send/abc123',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGhJk',
    'https://wns2-db5p.notify.windows.com/w/?token=BQYAAA',
    'https://FCM.googleapis.com/fcm/send/abc',
  ])('accepts %s', (endpoint) => {
    expect(pushEndpointProblem(endpoint)).toBeNull();
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://169.254.169.254/',
    'https://localhost/',
    'https://user:pass@fcm.googleapis.com/',
    'https://fcm.googleapis.com:8443/',
    'https://evil.example/',
    'https://fcm.googleapis.com.evil.example/',
    'https://evilnotify.windows.com/',
    'https://push.apple.com/',
    'not a url',
  ])('refuses %s', (endpoint) => {
    expect(pushEndpointProblem(endpoint)).not.toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const value of [undefined, null, 42, {}]) {
      expect(pushEndpointProblem(value)).not.toBeNull();
    }
  });

  it('never repeats the endpoint in its answer', () => {
    const endpoint = 'https://evil.example/device-secret-123';

    expect(pushEndpointProblem(endpoint)).not.toContain('device-secret-123');
  });
});
