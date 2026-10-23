import { CNC_ENVIRONMENTS, CncConfigService } from './cnc.config';

/**
 * The boot rules of CncConfigService.
 *
 * Every refusal case constructs the service rather than calling a method,
 * because the rules run in the constructor and the point of them is that the
 * process does not start. A test that called a validator directly would pass
 * while a service that never ran it shipped.
 */

const SECRET = 'a'.repeat(64);

/** A complete, valid production environment. Not real values. */
const PRODUCTION: Record<string, string> = {
  CNC_ENV: 'production',
  CNC_JWT_SECRET: SECRET,
  CNC_WEB_URL: 'https://tayxcnc.com/cnc',
  CNC_STAFF_URL: 'https://cnc-staff.tayxcnc.com',
  CNC_CORS_ORIGINS: 'https://tayxcnc.com, https://cnc-staff.tayxcnc.com',
  CNC_CONTACT_EMAIL: 'desk@example.com',
  CNC_PAYSTACK_SECRET_KEY: 'sk_live_not_a_real_key_0000000000',
  CNC_DB_URL: 'postgresql://u:p@host:5432/db?sslmode=require',
  CNC_SWEEP_TOKEN: 'b'.repeat(64),
};

/**
 * Replace every CNC_ and TAY_ variable with `base` plus `overrides`.
 * An override of `undefined` removes the key.
 */
function environment(
  base: Record<string, string>,
  overrides: Record<string, string | undefined> = {},
): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CNC_') || key.startsWith('TAY_')) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('the TAY namespace', () => {
  it('refuses to boot when any TAY_ variable is present', () => {
    environment({ CNC_JWT_SECRET: SECRET }, { TAY_DB_URL: 'x' });

    expect(() => new CncConfigService()).toThrow(
      /refusing to boot: found 1 TAY_-prefixed environment variable\(s\) in this process: TAY_DB_URL/,
    );
  });

  it('names the variable but never prints its value', () => {
    environment({ CNC_JWT_SECRET: SECRET }, { TAY_DB_URL: 'secret-value-xyz' });

    const message = refusal();

    expect(message).toContain('TAY_DB_URL');
    expect(message).not.toContain('secret-value-xyz');
  });
});

describe('CNC_JWT_SECRET', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  it('refuses to boot when unset', () => {
    environment({});

    expect(() => new CncConfigService()).toThrow(/CNC_JWT_SECRET is not set/);
  });

  it('refuses a secret shorter than 32 characters, without printing it', () => {
    environment({ CNC_JWT_SECRET: 'short-secret-value' });

    const message = refusal();

    expect(message).toMatch(
      /CNC_JWT_SECRET is 18 characters, below the required minimum of 32/,
    );
    expect(message).not.toContain('short-secret-value');
  });

  it.each(['CHANGE_ME', 'PLACEHOLDER_NOT_SET'])(
    'refuses the placeholder %s',
    (placeholder) => {
      environment({ CNC_JWT_SECRET: placeholder });

      expect(() => new CncConfigService()).toThrow(
        /CNC_JWT_SECRET is still a placeholder/,
      );
    },
  );

  it('refuses a secret of spaces, which only looks long enough', () => {
    environment({ CNC_JWT_SECRET: ' '.repeat(40) });

    expect(() => new CncConfigService()).toThrow(
      /CNC_JWT_SECRET is 0 characters/,
    );
  });

  it('accepts a 32-character secret', () => {
    environment({ CNC_JWT_SECRET: 'c'.repeat(32) });

    expect(new CncConfigService().jwtSecret).toBe('c'.repeat(32));
  });
});

describe('CNC_ENV', () => {
  it('names the three deployments and nothing else', () => {
    expect([...CNC_ENVIRONMENTS]).toEqual(['local', 'staging', 'production']);
  });

  it('falls back to local when unset outside a production container', () => {
    environment({ CNC_JWT_SECRET: SECRET });
    process.env.NODE_ENV = 'test';

    expect(new CncConfigService().cncEnv).toBe('local');
  });

  it('refuses to boot when unset in a production container', () => {
    environment({ CNC_JWT_SECRET: SECRET });
    process.env.NODE_ENV = 'production';

    expect(() => new CncConfigService()).toThrow(/CNC_ENV is not set/);
  });

  it('refuses a value that is not one of the three, without printing it', () => {
    environment({
      CNC_JWT_SECRET: SECRET,
      CNC_ENV: 'sk_live_mounted_by_mistake',
    });

    const message = refusal();

    expect(message).toMatch(/CNC_ENV is not one of local, staging, production/);
    expect(message).not.toContain('sk_live_mounted_by_mistake');
  });

  it('refuses local in a production build, where it would skip the deployed rules', () => {
    environment({ CNC_JWT_SECRET: SECRET, CNC_ENV: 'local' });
    process.env.NODE_ENV = 'production';

    expect(() => new CncConfigService()).toThrow(
      /CNC_ENV is local in a production build/,
    );
  });
});

describe('deployed rules (staging and production)', () => {
  const STAGING: Record<string, string> = {
    CNC_ENV: 'staging',
    CNC_JWT_SECRET: SECRET,
    CNC_SWEEP_TOKEN: 'b'.repeat(64),
    CNC_CORS_ORIGINS: 'https://cnc-staging.tayxcnc.com',
  };

  it('boots on staging with the sweep token and an origin', () => {
    environment(STAGING);

    expect(new CncConfigService().cncEnv).toBe('staging');
  });

  it('boots on staging with a test Paystack key or the placeholder', () => {
    for (const key of ['sk_test_x', 'PLACEHOLDER_NOT_SET']) {
      environment(STAGING, { CNC_PAYSTACK_SECRET_KEY: key });

      expect(refusal()).toBe('');
    }
  });

  it('refuses a live Paystack key outside production, without printing it', () => {
    environment(STAGING, {
      CNC_PAYSTACK_SECRET_KEY: 'sk_live_do_not_print_me',
    });

    const message = refusal();

    expect(message).toMatch(
      /CNC_PAYSTACK_SECRET_KEY is a live key outside production/,
    );
    expect(message).not.toContain('do_not_print_me');
  });

  it('refuses staging without a sweep token', () => {
    environment(STAGING, { CNC_SWEEP_TOKEN: undefined });

    expect(() => new CncConfigService()).toThrow(/CNC_SWEEP_TOKEN is not set/);
  });

  it.each(['CHANGE_ME', 'short-token'])(
    'refuses staging with the sweep token %s',
    (token) => {
      environment(STAGING, { CNC_SWEEP_TOKEN: token });

      expect(() => new CncConfigService()).toThrow(
        /CNC_SWEEP_TOKEN is a placeholder or shorter than 32 characters/,
      );
    },
  );

  it.each([
    'https://cnc-staging.tayxcnc.com/cnc',
    'https://cnc-staging.tayxcnc.com/',
    'cnc-staging.tayxcnc.com',
  ])(
    'refuses the origin %s, which can never match, without printing it',
    (origin) => {
      environment(STAGING, { CNC_CORS_ORIGINS: origin });

      const message = refusal();

      expect(message).toMatch(/1 entr\(ies\) that are not a bare origin/);
      expect(message).not.toContain('cnc-staging');
    },
  );

  it('accepts a bare origin with a port', () => {
    environment(STAGING, {
      CNC_CORS_ORIGINS: 'https://cnc-staging.tayxcnc.com,http://localhost:3001',
    });

    expect(new CncConfigService().corsOrigins).toHaveLength(2);
  });

  it('refuses staging with an empty origin list', () => {
    environment(STAGING, { CNC_CORS_ORIGINS: ' , ' });

    expect(() => new CncConfigService()).toThrow(/CNC_CORS_ORIGINS is empty/);
  });

  it('reports both problems at once', () => {
    environment(STAGING, {
      CNC_SWEEP_TOKEN: undefined,
      CNC_CORS_ORIGINS: undefined,
    });

    expect(() => new CncConfigService()).toThrow(
      /2 configuration problem\(s\)/,
    );
  });

  it('keeps both optional locally', () => {
    environment({ CNC_JWT_SECRET: SECRET, CNC_ENV: 'local' });

    expect(new CncConfigService().sweepToken).toBeUndefined();
  });
});

describe('production rules', () => {
  it('boots with a complete production environment', () => {
    environment(PRODUCTION);

    expect(new CncConfigService().cncEnv).toBe('production');
  });

  it.each([
    ['CNC_WEB_URL', undefined, /CNC_WEB_URL is not set/],
    ['CNC_WEB_URL', 'http://tayxcnc.com/cnc', /CNC_WEB_URL must begin/],
    ['CNC_WEB_URL', 'https://tayxcnc.com/cnc/', /must not end in a slash/],
    ['CNC_WEB_URL', 'https://tayxcnc.com', /CNC_WEB_URL must end in \/cnc/],
    ['CNC_STAFF_URL', undefined, /CNC_STAFF_URL is not set/],
    ['CNC_STAFF_URL', 'http://cnc-staff.tayxcnc.com', /CNC_STAFF_URL must/],
    ['CNC_CORS_ORIGINS', 'http://localhost:3001', /not https/],
    ['CNC_CONTACT_EMAIL', undefined, /CNC_CONTACT_EMAIL is not set/],
    ['CNC_PAYSTACK_SECRET_KEY', 'sk_test_x', /not a live key/],
    ['CNC_DB_URL', 'postgresql://u:p@h:5432/d', /socket form/],
  ])('refuses %s = %s', (key, value, message) => {
    environment(PRODUCTION, { [key]: value });

    expect(() => new CncConfigService()).toThrow(message);
  });

  it('accepts the Cloud SQL socket form without sslmode', () => {
    environment(PRODUCTION, {
      CNC_DB_URL:
        'postgresql://u:p@localhost/cnc_db?host=/cloudsql/p:europe-west1:i',
    });

    expect(new CncConfigService().cncEnv).toBe('production');
  });

  it('never prints the payment key or the database URL', () => {
    environment(PRODUCTION, {
      CNC_PAYSTACK_SECRET_KEY: 'sk_test_do_not_print_me',
      CNC_DB_URL: 'postgresql://user:do-not-print@h:5432/d',
    });

    let message = '';
    try {
      new CncConfigService();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/2 configuration problem\(s\)/);
    expect(message).not.toContain('do_not_print_me');
    expect(message).not.toContain('do-not-print');
  });

  it('does not apply on staging', () => {
    environment(PRODUCTION, {
      CNC_ENV: 'staging',
      CNC_PAYSTACK_SECRET_KEY: 'sk_test_x',
      CNC_WEB_URL: undefined,
    });

    expect(new CncConfigService().cncEnv).toBe('staging');
  });
});

describe('buildWebUrl', () => {
  it('joins a path onto the base, which carries /cnc', () => {
    environment(PRODUCTION);

    expect(new CncConfigService().buildWebUrl('/account')).toBe(
      'https://tayxcnc.com/cnc/account',
    );
  });

  it('uses exactly one slash whichever side supplied one', () => {
    environment(
      { CNC_JWT_SECRET: SECRET },
      { CNC_WEB_URL: 'http://localhost:3001/cnc/' },
    );

    expect(new CncConfigService().buildWebUrl('account/orders')).toBe(
      'http://localhost:3001/cnc/account/orders',
    );
  });

  it('returns undefined when the base is unset or blank', () => {
    environment({ CNC_JWT_SECRET: SECRET }, { CNC_WEB_URL: '   ' });

    expect(new CncConfigService().buildWebUrl('/account')).toBeUndefined();
  });
});

describe('getters', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  it('trims the origin list', () => {
    environment(
      { CNC_JWT_SECRET: SECRET },
      { CNC_CORS_ORIGINS: ' https://a.example , https://b.example ,' },
    );

    expect(new CncConfigService().corsOrigins).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('reads the payment key lazily, refusing only when asked for it', () => {
    environment({ CNC_JWT_SECRET: SECRET });
    const config = new CncConfigService();

    expect(() => config.paystackSecretKey).toThrow(
      /CNC_PAYSTACK_SECRET_KEY is not set/,
    );
  });

  it('reads the checkout key as unset when blank or a placeholder', () => {
    for (const key of [undefined, ' ', 'PLACEHOLDER_NOT_SET', 'CHANGE_ME']) {
      environment({ CNC_JWT_SECRET: SECRET }, { CNC_PAYSTACK_SECRET_KEY: key });

      expect(new CncConfigService().paystackKey).toBeUndefined();
    }

    environment(
      { CNC_JWT_SECRET: SECRET },
      { CNC_PAYSTACK_SECRET_KEY: 'sk_test_x' },
    );

    expect(new CncConfigService().paystackKey).toBe('sk_test_x');
  });

  it('treats blank optional values as unset', () => {
    environment(
      { CNC_JWT_SECRET: SECRET },
      { CNC_MAIL_FROM: ' ', CNC_STAFF_URL: '', CNC_CONTACT_EMAIL: '  ' },
    );
    const config = new CncConfigService();

    expect(config.mailFrom).toBeUndefined();
    expect(config.staffUrl).toBeUndefined();
    expect(config.contactEmail).toBeUndefined();
  });

  it('treats a placeholder mail key or sender as unset (C6)', () => {
    environment(
      { CNC_JWT_SECRET: SECRET },
      {
        CNC_RESEND_API_KEY: 'PLACEHOLDER_NOT_SET',
        CNC_MAIL_FROM: 'CHANGE_ME',
      },
    );
    const config = new CncConfigService();

    expect(config.resendApiKey).toBeUndefined();
    expect(config.mailFrom).toBeUndefined();
  });

  it('reads a real mail key and sender', () => {
    environment(
      { CNC_JWT_SECRET: SECRET },
      {
        CNC_RESEND_API_KEY: 're_not_a_real_key',
        CNC_MAIL_FROM: 'CNC <cnc@example.com>',
      },
    );
    const config = new CncConfigService();

    expect(config.resendApiKey).toBe('re_not_a_real_key');
    expect(config.mailFrom).toBe('CNC <cnc@example.com>');
  });
});

describe('secureCookies (A16)', () => {
  const STAGING: Record<string, string> = {
    CNC_ENV: 'staging',
    CNC_JWT_SECRET: SECRET,
    CNC_SWEEP_TOKEN: 'b'.repeat(64),
    CNC_CORS_ORIGINS: 'https://cnc-staging.tayxcnc.com',
  };

  // Staging is a built container: NODE_ENV=production, CNC_ENV=staging. A
  // getter that read CNC_ENV would answer false here and every e2e suite,
  // which runs with NODE_ENV=test, would still pass.
  it('is on in a built container on staging', () => {
    environment(STAGING);
    process.env.NODE_ENV = 'production';

    expect(new CncConfigService().secureCookies).toBe(true);
  });

  it('is on in a built container in production', () => {
    environment(PRODUCTION);
    process.env.NODE_ENV = 'production';

    expect(new CncConfigService().secureCookies).toBe(true);
  });

  it.each(['test', 'development'])('is off with NODE_ENV=%s', (nodeEnv) => {
    environment({ CNC_JWT_SECRET: SECRET });
    process.env.NODE_ENV = nodeEnv;

    expect(new CncConfigService().secureCookies).toBe(false);
  });
});
