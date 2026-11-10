import {
  CONFIG_PATH,
  configReadsIn,
  entriesIn,
  envReadsIn,
  evaluate,
  isAllowedName,
  mountDrift,
  mountsInScript,
  mountsInWorkflow,
  type CheckInput,
  type DeployMounts,
  type Mount,
} from './check-env-names';

const CONFIG = `
const OWN_PREFIX = 'CNC_';
export class CncConfigService {
  get databaseUrl(): string {
    return this.ownOrThrow('DB_URL');
  }
  get webUrl(): string | undefined {
    return this.own('WEB_URL');
  }
  get mailFrom(): string | undefined {
    return this.ownOptional('MAIL_FROM');
  }
  get owner(): string | undefined {
    return this.owner2('NOT_A_READER');
  }
  get port(): number {
    return Number(process.env.PORT ?? 3000);
  }
  private own(suffix: string): string | undefined {
    // process.env.TAY_DB_URL in a comment is not a read.
    return process.env[\`\${OWN_PREFIX}\${suffix}\`];
  }
  private ownOrThrow(suffix: string): string {
    const value = this.own(suffix);
    if (value === undefined) throw new Error('missing');
    return value;
  }
  private refuseForeign(): void {
    const leaked = Object.keys(process.env).filter((key) =>
      key.startsWith('TAY_'),
    );
    if (leaked.length > 0) throw new Error('TAY_ present');
  }
}
`;

const WORKFLOW = `
name: Deploy to staging

jobs:
  cnc:
    name: Deploy CNC to staging
    if: false
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy "$SERVICE" \\
            --set-env-vars "CNC_ENV=staging" \\
            --set-secrets "CNC_DB_URL=CNC_DB_URL:latest,CNC_WEB_URL=CNC_WEB_URL:latest" \\
            --quiet
  other:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`;

/** A deploy workflow whose `cnc` job mounts the given secret list. */
function deployWorkflow(secrets: string): string {
  return `
jobs:
  cnc:
    runs-on: ubuntu-latest
    steps:
      - run: |
          gcloud run deploy "$SERVICE" \\
            --set-env-vars "CNC_ENV=production" \\
            --set-secrets "${secrets}" \\
            --quiet
`;
}

/** The `cnc` job's mounted names, as main() gathers them per workflow. */
function deployMountsOf(text: string, path: string): DeployMounts {
  return {
    path,
    names: (mountsInWorkflow(text, path).get('cnc') ?? []).map(
      (each) => each.name,
    ),
  };
}

function mount(overrides: Partial<Mount> & { name: string }): Mount {
  return {
    secret: null,
    source: 'deploy-staging.yml job "cnc"',
    disabled: false,
    ...overrides,
  };
}

/** A clean input: everything mounted is read, and every read is CNC_. */
function cleanInput(): CheckInput {
  return {
    configPath: CONFIG_PATH,
    config: { names: ['CNC_DB_URL', 'CNC_WEB_URL'], ownPrefix: 'CNC_' },
    mounts: [
      mount({ name: 'CNC_DB_URL', secret: 'CNC_DB_URL' }),
      mount({ name: 'CNC_WEB_URL', secret: 'CNC_WEB_URL' }),
    ],
    deployMounts: [],
    envReads: [
      { name: 'PORT', file: CONFIG_PATH, line: 10 },
      { name: 'CNC_DB_URL', file: 'prisma.config.ts', line: 5 },
    ],
    unchecked: [],
    unattributed: [],
  };
}

describe('check-env-names', () => {
  describe('isAllowedName', () => {
    it.each(['CNC_DB_URL', 'PORT', 'NODE_ENV'])('allows %s', (name) => {
      expect(isAllowedName(name)).toBe(true);
    });

    it.each(['TAY_DB_URL', 'CORS_ORIGINS', 'MAIL_FROM', 'cnc_db_url'])(
      'refuses %s',
      (name) => {
        expect(isAllowedName(name)).toBe(false);
      },
    );
  });

  describe('configReadsIn', () => {
    it('reads OWN_PREFIX and every literal own*() name', () => {
      const reads = configReadsIn(CONFIG, CONFIG_PATH);

      expect(reads.ownPrefix).toBe('CNC_');
      expect(reads.names.sort()).toEqual([
        'CNC_DB_URL',
        'CNC_MAIL_FROM',
        'CNC_WEB_URL',
      ]);
    });

    it('reports a missing OWN_PREFIX as null', () => {
      const reads = configReadsIn(`this.own('DB_URL');`, CONFIG_PATH);

      expect(reads.ownPrefix).toBeNull();
      expect(reads.names).toEqual(['CNC_DB_URL']);
    });

    it('prefixes own() names with the prefix the config actually declares', () => {
      const reads = configReadsIn(
        `const OWN_PREFIX = 'TAY_'; this.own('DB_URL');`,
        CONFIG_PATH,
      );

      expect(reads.ownPrefix).toBe('TAY_');
      expect(reads.names).toEqual(['TAY_DB_URL']);
    });
  });

  describe('envReadsIn', () => {
    it('finds dotted, bracketed, constant-keyed and destructured reads', () => {
      const scan = envReadsIn(
        [
          `const KEY = 'CNC_SEED_OWNER_EMAIL';`,
          `const a = process.env.CNC_DB_URL;`,
          `const b = process.env['NODE_ENV'];`,
          `const c = process.env[KEY];`,
          `const { PORT, CNC_ENV: env } = process.env;`,
        ].join('\n'),
        'prisma/seed.ts',
      );

      expect(scan.reads).toEqual([
        { name: 'CNC_DB_URL', file: 'prisma/seed.ts', line: 2 },
        { name: 'NODE_ENV', file: 'prisma/seed.ts', line: 3 },
        { name: 'CNC_SEED_OWNER_EMAIL', file: 'prisma/seed.ts', line: 4 },
        { name: 'PORT', file: 'prisma/seed.ts', line: 5 },
        { name: 'CNC_ENV', file: 'prisma/seed.ts', line: 5 },
      ]);
      expect(scan.unchecked).toEqual([]);
    });

    it('ignores names in comments and strings', () => {
      const scan = envReadsIn(
        [
          `// process.env.TAY_DB_URL`,
          `/* process.env.CORS_ORIGINS */`,
          `const text = 'process.env.MAIL_FROM';`,
        ].join('\n'),
        'src/a.ts',
      );

      expect(scan.reads).toEqual([]);
      expect(scan.unchecked).toEqual([]);
    });

    it('lists reads whose name cannot be known', () => {
      const scan = envReadsIn(
        [
          `function get(name: string) { return process.env[name]; }`,
          `const all = { ...process.env };`,
        ].join('\n'),
        'src/a.ts',
      );

      expect(scan.reads).toEqual([]);
      expect(scan.unchecked.map((each) => each.line)).toEqual([1, 2]);
    });
  });

  describe('entriesIn', () => {
    it('splits secrets into the mounted name and its source secret', () => {
      expect(
        entriesIn('CNC_DB_URL=CNC_DB_URL:latest, CNC_X=OTHER:3', 'secrets'),
      ).toEqual([
        { name: 'CNC_DB_URL', secret: 'CNC_DB_URL' },
        { name: 'CNC_X', secret: 'OTHER' },
      ]);
    });

    it('keeps env-var values out of the result', () => {
      expect(entriesIn('CNC_ENV=staging,CNC_A=b=c', 'env-vars')).toEqual([
        { name: 'CNC_ENV', secret: null },
        { name: 'CNC_A', secret: null },
      ]);
    });
  });

  describe('mountsInWorkflow', () => {
    it('attributes mounts to their job and notices if: false', () => {
      const byJob = mountsInWorkflow(WORKFLOW, 'deploy-staging.yml');
      const cnc = byJob.get('cnc') ?? [];

      expect(cnc.map((each) => [each.name, each.secret])).toEqual([
        ['CNC_ENV', null],
        ['CNC_DB_URL', 'CNC_DB_URL'],
        ['CNC_WEB_URL', 'CNC_WEB_URL'],
      ]);
      expect(cnc.every((each) => each.disabled)).toBe(true);
      expect(byJob.get('other')).toEqual([]);
    });

    it('reads operator scripts as enabled', () => {
      const found = mountsInScript(
        `gcloud run deploy x --set-secrets="CNC_DB_URL=CNC_DB_URL:latest"`,
        'scripts/prod/deploy.sh',
      );

      expect(found).toEqual([
        {
          name: 'CNC_DB_URL',
          secret: 'CNC_DB_URL',
          source: 'scripts/prod/deploy.sh --set-secrets',
          disabled: false,
        },
      ]);
    });
  });

  describe('evaluate', () => {
    it('passes a clean input', () => {
      const result = evaluate(cleanInput());

      expect(result.failures).toBe(0);
      expect(result.lines).toContain('Result: 0 violations.');
    });

    it('fails an unprefixed process.env read anywhere scanned', () => {
      const input = cleanInput();
      input.envReads.push({
        name: 'CORS_ORIGINS',
        file: 'src/bootstrap.ts',
        line: 12,
      });

      const result = evaluate(input);

      expect(result.failures).toBe(1);
      expect(result.lines).toContain(
        '        - CORS_ORIGINS  (src/bootstrap.ts:12)',
      );
    });

    it('fails a TAY_ read once, as foreign, not also as unprefixed', () => {
      const input = cleanInput();
      input.envReads.push({
        name: 'TAY_DB_URL',
        file: 'scripts/x.ts',
        line: 3,
      });

      const result = evaluate(input);

      expect(result.failures).toBe(1);
      expect(result.lines).toContain('   FAIL 3. foreign prefix TAY_: 1');
    });

    it('fails a CNC_ name mounted from a TAY_ secret', () => {
      const input = cleanInput();
      input.mounts[0] = mount({ name: 'CNC_DB_URL', secret: 'TAY_DB_URL' });

      expect(evaluate(input).failures).toBe(1);
    });

    it('fails a CNC_ name mounted from an unprefixed secret', () => {
      const input = cleanInput();
      input.mounts[0] = mount({ name: 'CNC_DB_URL', secret: 'DB_URL' });

      expect(evaluate(input).failures).toBe(1);
    });

    it('fails a mount the config never reads, and only warns when the job is off', () => {
      const enabled = cleanInput();
      enabled.mounts.push(mount({ name: 'CNC_UNUSED', secret: 'CNC_UNUSED' }));
      expect(evaluate(enabled).failures).toBe(1);

      const disabled = cleanInput();
      disabled.mounts.push(
        mount({ name: 'CNC_UNUSED', secret: 'CNC_UNUSED', disabled: true }),
      );
      expect(evaluate(disabled).failures).toBe(0);
    });

    it('still fails a foreign mount in a job that is switched off', () => {
      const input = cleanInput();
      input.mounts.push(
        mount({ name: 'MAIL_FROM', secret: 'MAIL_FROM', disabled: true }),
      );

      // Unprefixed as a name, unprefixed as a secret: two violations, and the
      // never-read warning does not count.
      expect(evaluate(input).failures).toBe(2);
    });

    it('only warns on a read the config makes that nothing mounts', () => {
      const input = cleanInput();
      input.config!.names.push('CNC_CONTACT_EMAIL');

      const result = evaluate(input);

      expect(result.failures).toBe(0);
      expect(result.lines).toContain('   warn 2. read but never mounted: 2');
    });

    it('fails a missing or wrong OWN_PREFIX, and a missing config', () => {
      const missing = cleanInput();
      missing.config!.ownPrefix = null;
      expect(evaluate(missing).failures).toBe(1);

      const wrong = cleanInput();
      wrong.config!.ownPrefix = 'TAY_';
      expect(evaluate(wrong).failures).toBe(1);

      const absent = cleanInput();
      absent.config = null;
      absent.mounts = [];
      expect(evaluate(absent).failures).toBe(1);
    });

    it('fails an unchecked read outside the config, and not one inside it', () => {
      const input = cleanInput();
      input.unchecked.push(
        { file: CONFIG_PATH, line: 30, reason: 'computed name' },
        { file: 'prisma/seed.ts', line: 4, reason: 'process.env used whole' },
      );

      const result = evaluate(input);

      expect(result.failures).toBe(1);
      expect(result.lines).toContain(
        '   FAIL 5. process.env reads whose name cannot be checked: 1',
      );
    });

    it('fails mounts in a job that deploys no known service', () => {
      const input = cleanInput();
      input.unattributed.push('deploy-staging.yml job "other"');

      expect(evaluate(input).failures).toBe(1);
    });

    it('fails a name mounted by one deploy workflow and not the other', () => {
      const staging = deployMountsOf(
        deployWorkflow(
          'CNC_DB_URL=CNC_DB_URL:latest,CNC_WEB_URL=CNC_WEB_URL:latest',
        ),
        'deploy-staging.yml',
      );
      const production = deployMountsOf(
        deployWorkflow('CNC_DB_URL=CNC_DB_URL:1'),
        'deploy-production.yml',
      );
      const input = cleanInput();
      input.deployMounts = [staging, production];

      const result = evaluate(input);

      expect(result.failures).toBe(1);
      expect(result.lines).toContain(
        '   FAIL 6. mounted by one deploy workflow and not the other: 1',
      );
      expect(result.lines).toContain(
        '        - CNC_WEB_URL  (mounted by deploy-staging.yml; not by deploy-production.yml)',
      );
    });
  });

  describe('mountDrift', () => {
    it('passes two deploy workflows that mount the same names, in any order', () => {
      expect(
        mountDrift([
          { path: 'a.yml', names: ['CNC_ENV', 'CNC_DB_URL'] },
          { path: 'b.yml', names: ['CNC_DB_URL', 'CNC_ENV'] },
        ]),
      ).toEqual([]);
    });

    it('compares nothing while only one deploy workflow exists', () => {
      expect(mountDrift([{ path: 'a.yml', names: ['CNC_DB_URL'] }])).toEqual(
        [],
      );
    });
  });
});
