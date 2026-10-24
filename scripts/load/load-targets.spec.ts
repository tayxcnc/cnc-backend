import {
  backoffMs,
  checkLoadTargets,
  CNC_STAGING_LOAD_HOST,
} from './load-targets';

describe('checkLoadTargets', () => {
  const local = { confirmStaging: undefined, spoofAddresses: false };
  const staging = `https://${CNC_STAGING_LOAD_HOST}`;

  it('accepts a backend on this machine, spoofing included', () => {
    expect(
      checkLoadTargets(
        [
          'http://localhost:3000',
          'http://127.0.0.1:3001/',
          'http://[::1]:3002',
        ],
        { confirmStaging: undefined, spoofAddresses: true },
      ),
    ).toEqual([
      'http://localhost:3000',
      'http://127.0.0.1:3001',
      'http://[::1]:3002',
    ]);
  });

  it.each([
    'https://api-cnc.tayxcnc.com',
    'https://api.tayxcnc.com',
    'https://api-cnc-staging.tayxcnc.com.evil.example',
    'https://tayxcnc-cnc-staging-abc-ew.a.run.app',
    'http://192.168.1.10:3000',
  ])('refuses %s, however confirmed', (url) => {
    expect(() =>
      checkLoadTargets([url], {
        confirmStaging: CNC_STAGING_LOAD_HOST,
        spoofAddresses: false,
      }),
    ).toThrow(/neither a local backend nor CNC staging/);
  });

  it('refuses one bad origin among good ones', () => {
    expect(() =>
      checkLoadTargets(
        ['http://localhost:3000', 'https://api-cnc.tayxcnc.com'],
        local,
      ),
    ).toThrow(/neither a local backend nor CNC staging/);
  });

  it('refuses CNC staging without the confirmation, or with a wrong one', () => {
    expect(() => checkLoadTargets([staging], local)).toThrow(
      /CNC_LOAD_CONFIRM_STAGING=api-cnc-staging\.tayxcnc\.com/,
    );
    expect(() =>
      checkLoadTargets([staging], {
        confirmStaging: 'yes',
        spoofAddresses: false,
      }),
    ).toThrow(/CNC_LOAD_CONFIRM_STAGING/);
  });

  it('accepts CNC staging confirmed by its host, over https, without spoofing', () => {
    const confirmed = {
      confirmStaging: CNC_STAGING_LOAD_HOST,
      spoofAddresses: false,
    };

    expect(checkLoadTargets([`${staging}/`], confirmed)).toEqual([staging]);
    expect(() =>
      checkLoadTargets([`http://${CNC_STAGING_LOAD_HOST}`], confirmed),
    ).toThrow(/https only/);
    expect(() =>
      checkLoadTargets([staging], { ...confirmed, spoofAddresses: true }),
    ).toThrow(/CNC_LOAD_SPOOF_ADDRESSES is for a local backend only/);
  });

  it('refuses no origin, and what is not an http origin', () => {
    expect(() => checkLoadTargets([], local)).toThrow(/at least one/);
    expect(() => checkLoadTargets(['localhost:3000'], local)).toThrow();
    expect(() => checkLoadTargets(['not a url'], local)).toThrow(/Not a URL/);
  });
});

describe('backoffMs', () => {
  it('waits what Retry-After says, at most a minute, else one second', () => {
    expect(backoffMs('2')).toBe(2000);
    expect(backoffMs('0')).toBe(0);
    expect(backoffMs('3600')).toBe(60_000);
    expect(backoffMs(null)).toBe(1000);
    expect(backoffMs('soon')).toBe(1000);
  });
});
