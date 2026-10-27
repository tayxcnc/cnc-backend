import { Logger } from '@nestjs/common';
import { createECDH } from 'node:crypto';
import { testVapidEnv, testVapidTrio } from '../../test/vapid-test-pair';
import { CncConfigService } from './cnc.config';

/**
 * C10: the web push trio at boot, ported from TAY's `vapid.spec.ts` with
 * CNC's names and the derived-key rule.
 *
 * Every case constructs the service, because the check runs in the
 * constructor and its point is that the process does not start. The pair is
 * `testVapidTrio()`, a real one: the boot refuses a public key the private
 * key does not derive.
 */

const { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY } = testVapidTrio();
const SUBJECT = 'mailto:chefnoroculinarycnc@gmail.com';
const TRIO = testVapidEnv();

/** Enough for CNC to boot on staging, bar the trio. */
const CNC_STAGING = {
  CNC_ENV: 'staging',
  CNC_JWT_SECRET: 'a'.repeat(64),
  CNC_SWEEP_TOKEN: 'b'.repeat(64),
  CNC_CORS_ORIGINS: 'https://cnc-staging.tayxcnc.com',
};

const CNC_LOCAL = { CNC_ENV: 'local', CNC_JWT_SECRET: 'a'.repeat(64) };

const ORIGINAL_ENV = process.env;

/** A controlled environment: no TAY_, CNC_ or VAPID_ from the shell. */
function useEnv(values: Record<string, string>): void {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (
      !key.startsWith('TAY_') &&
      !key.startsWith('CNC_') &&
      !key.startsWith('VAPID_')
    ) {
      env[key] = value;
    }
  }

  process.env = { ...env, NODE_ENV: 'test', ...values };
}

/** The message the constructor refuses with, or '' when it boots. */
function refusal(): string {
  try {
    new CncConfigService();
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

afterEach(() => {
  process.env = ORIGINAL_ENV;
  jest.restoreAllMocks();
});

describe('CncConfigService: the CNC_VAPID_* trio (C10)', () => {
  it('hands out all three when they are well formed and a pair', () => {
    useEnv({ ...CNC_STAGING, ...TRIO });

    expect(new CncConfigService().vapid()).toEqual({
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
      subject: SUBJECT,
    });
  });

  it('trims each value, so a newline from `echo` cannot become part of a key', () => {
    useEnv({
      ...CNC_STAGING,
      CNC_VAPID_PUBLIC_KEY: `${PUBLIC_KEY}\n`,
      CNC_VAPID_PRIVATE_KEY: ` ${PRIVATE_KEY}`,
      CNC_VAPID_SUBJECT: `${SUBJECT}\n`,
    });

    expect(new CncConfigService().vapid()).toEqual({
      publicKey: PUBLIC_KEY,
      privateKey: PRIVATE_KEY,
      subject: SUBJECT,
    });
  });

  it('refuses a malformed public key, PLACEHOLDER_NOT_SET included, and never prints it', () => {
    for (const bad of [
      'PLACEHOLDER_NOT_SET',
      Buffer.alloc(64, 4).toString('base64url'),
      `${PUBLIC_KEY.slice(0, -1)}+`,
    ]) {
      useEnv({ ...CNC_STAGING, ...TRIO, CNC_VAPID_PUBLIC_KEY: bad });

      const message = refusal();

      expect(message).toMatch(
        /^CNC service refusing to boot: CNC_VAPID_PUBLIC_KEY must be URL-safe base64 of 65 bytes\./,
      );
      expect(message).not.toContain(bad);
    }
  });

  it('refuses a private key that is not 32 bytes, without printing it', () => {
    const bad = Buffer.alloc(31, 7).toString('base64url');
    useEnv({ ...CNC_STAGING, ...TRIO, CNC_VAPID_PRIVATE_KEY: bad });

    const message = refusal();

    expect(message).toMatch(
      /CNC_VAPID_PRIVATE_KEY must be URL-safe base64 of 32 bytes/,
    );
    expect(message).not.toContain(bad);
  });

  it('refuses either key padded with "=", which web-push would refuse later, without printing it', () => {
    for (const [name, padded] of [
      ['CNC_VAPID_PUBLIC_KEY', `${PUBLIC_KEY}=`],
      ['CNC_VAPID_PRIVATE_KEY', `${PRIVATE_KEY}=`],
    ]) {
      useEnv({ ...CNC_STAGING, ...TRIO, [name]: padded });

      const message = refusal();

      expect(message).toMatch(
        new RegExp(
          `^CNC service refusing to boot: ${name} must be URL-safe base64 without "=" padding`,
        ),
      );
      expect(message).not.toContain(padded);
    }
  });

  it('refuses a public key of the right length from a different pair, without printing either key', () => {
    const other = createECDH('prime256v1');
    other.setPrivateKey(Buffer.alloc(32, 9));
    const otherPublic = other.getPublicKey().toString('base64url');
    useEnv({ ...CNC_STAGING, ...TRIO, CNC_VAPID_PUBLIC_KEY: otherPublic });

    const message = refusal();

    expect(message).toMatch(
      /^CNC service refusing to boot: CNC_VAPID_PRIVATE_KEY does not match CNC_VAPID_PUBLIC_KEY/,
    );
    expect(message).not.toContain(otherPublic);
    expect(message).not.toContain(PRIVATE_KEY);
  });

  it('refuses a subject that is not mailto: or https:, or that names localhost', () => {
    for (const [subject, rule] of [
      ['chefnoroculinarycnc@gmail.com', /must begin mailto: or https:/],
      ['mailto:push@localhost', /must not name localhost/],
      ['https://localhost:3000', /must not name localhost/],
      ['https://api.localhost', /must not name localhost/],
      ['mailto:nobody', /mailto: address with a domain/],
    ] as const) {
      useEnv({ ...CNC_STAGING, ...TRIO, CNC_VAPID_SUBJECT: subject });

      expect(refusal()).toMatch(rule);
    }

    useEnv({ ...CNC_STAGING, ...TRIO, CNC_VAPID_SUBJECT: SUBJECT });
    expect(new CncConfigService().vapid()?.subject).toBe(SUBJECT);

    useEnv({
      ...CNC_STAGING,
      ...TRIO,
      CNC_VAPID_SUBJECT: 'https://tayxcnc.com/cnc',
    });
    expect(new CncConfigService().vapid()?.subject).toBe(
      'https://tayxcnc.com/cnc',
    );
  });

  it('refuses a partial trio anywhere, local included, naming what is missing', () => {
    for (const base of [CNC_LOCAL, CNC_STAGING]) {
      useEnv({ ...base, CNC_VAPID_PUBLIC_KEY: PUBLIC_KEY });

      expect(refusal()).toMatch(
        /CNC_VAPID_PRIVATE_KEY, CNC_VAPID_SUBJECT are not set, but the other VAPID values are\. Set all three or none\./,
      );
    }
  });

  it('refuses staging with none of the three, among the deployed problems', () => {
    useEnv(CNC_STAGING);

    expect(refusal()).toMatch(
      /^CNC service refusing to boot in staging\. 1 configuration problem\(s\):\n {2}- CNC_VAPID_PUBLIC_KEY, CNC_VAPID_PRIVATE_KEY and CNC_VAPID_SUBJECT are not set/,
    );
  });

  it('boots locally with none of the three, returns null, and warns once', () => {
    useEnv(CNC_LOCAL);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    const config = new CncConfigService();

    expect(config.vapid()).toBeNull();
    expect(config.vapid()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      'CNC_VAPID_* not set: web push is skipped. In-app and email are ' +
        'unaffected.',
    );
  });

  it('ignores TAY’s unprefixed VAPID_* names, and a TAY_VAPID_* refuses the boot', () => {
    useEnv({
      ...CNC_LOCAL,
      VAPID_PUBLIC_KEY: PUBLIC_KEY,
      VAPID_PRIVATE_KEY: PRIVATE_KEY,
      VAPID_SUBJECT: SUBJECT,
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    expect(new CncConfigService().vapid()).toBeNull();

    useEnv({ ...CNC_STAGING, ...TRIO, TAY_VAPID_PRIVATE_KEY: PRIVATE_KEY });

    const message = refusal();

    expect(message).toMatch(
      /found 1 TAY_-prefixed environment variable\(s\) in this process: TAY_VAPID_PRIVATE_KEY/,
    );
    expect(message).not.toContain(PRIVATE_KEY);
  });
});
