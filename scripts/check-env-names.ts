import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';

/**
 * Check every environment variable name this service mounts or reads.
 *
 * Run from the repository root, by hand or in CI:
 *
 *   npm run check:env-names
 *
 * which is `ts-node scripts/check-env-names.ts`. It needs no database, no
 * credential and no network: it reads files as text and prints names only,
 * never a value. It exits non-zero when anything fails.
 *
 * ## Why it exists
 *
 * A name that is wrong fails silently. `CncConfigService` reads a variable
 * through `own()` and the readers built on it, which add `CNC_`. A secret mounted under
 * any other name is accepted by Secret Manager, mounted by Cloud Run, and never
 * read: the service boots, and the feature fails later, in front of someone.
 *
 * And a name that is foreign is worse. CNC shares the staging project (and
 * later the production project) with TAY. Every CNC setting is `CNC_`-prefixed
 * except `PORT` and `NODE_ENV`, so that CNC can never mount or read a TAY
 * value: TAY's unprefixed names (`CORS_ORIGINS`, `MAIL_FROM`...) are TAY's own
 * secrets, and if CNC read them, a TAY change would alter CNC.
 *
 * ## What it reads
 *
 * - every `own('X')`, `ownOrThrow('X')` and `ownOptional('X')` (any
 *   `own*('X')`) in `src/config/cnc.config.ts`, and its `OWN_PREFIX`, which
 *   must be `'CNC_'`;
 * - every `process.env` read (`process.env.X`, `process.env['X']`, a
 *   `process.env[NAME]` whose `NAME` is a string constant in the same file, and
 *   `const { X } = process.env`) in every `.ts` file under `src/`, `prisma/`
 *   and `scripts/`, and in `prisma.config.ts`. It parses the files, so a name
 *   in a comment or a string is not a read. Spec files are skipped: a spec
 *   sets a TAY_ variable on purpose to prove the config refuses it, and
 *   nothing in a spec runs in a deployed service (test/ is not scanned
 *   either);
 * - the `--set-secrets` and `--set-env-vars` strings of the `cnc` job in
 *   `.github/workflows/deploy-staging.yml`, and in
 *   `.github/workflows/deploy-production.yml` and `scripts/prod/*` when they
 *   exist.
 *
 * ## What it reports
 *
 * 0. `OWN_PREFIX` missing from the config, or not `'CNC_'`: **fails**. Every
 *    name below that comes from `own()` assumes it.
 * 1. Mounted but never read by the config: **fails**.
 * 2. Read by the config but never mounted: a warning. Some reads are optional,
 *    or are provided by the platform (`PORT` by Cloud Run, `NODE_ENV` by the
 *    Dockerfile).
 * 3. The foreign prefix `TAY_`, mounted, mounted from, or read anywhere
 *    scanned: **fails**.
 * 4. Any other name that is not `CNC_*`, `PORT` or `NODE_ENV`, mounted or
 *    read anywhere scanned, or a secret mounted from a Secret Manager secret
 *    whose own name is not `CNC_*`: **fails**. Mounting `TAY_DB_URL` under the
 *    name `CNC_DB_URL` would read TAY's value through a CNC name.
 * 5. A `process.env` read whose name cannot be known from the source (a
 *    computed key, or the object passed or spread whole) outside the config:
 *    a warning, listed so a reviewer can look.
 *
 * A job that is switched off (`if: false`) mounts nothing, so its kind-1
 * names are listed as a warning until it is switched on. Kinds 3 and 4 still
 * fail there: a wrong name is wrong before the job runs.
 */

export const OWN_PREFIX = 'CNC_';
export const FOREIGN_PREFIX = 'TAY_';
export const CONFIG_PATH = 'src/config/cnc.config.ts';

/** Job keys in a deploy workflow that deploy this service. */
export const JOB_KEYS = ['cnc'];

const WORKFLOWS = [
  '.github/workflows/deploy-staging.yml',
  '.github/workflows/deploy-production.yml',
];

const PROD_SCRIPTS_DIR = 'scripts/prod';

/** Where `process.env` reads are looked for. */
const SCAN_DIRS = ['src', 'prisma', 'scripts'];
const SCAN_FILES = ['prisma.config.ts'];
const SKIPPED_DIRS = new Set(['node_modules', 'generated', 'dist']);

/**
 * The only unprefixed names this service may read. Both are supplied by the
 * platform, so an unmounted read of them is expected.
 */
export const PLATFORM_PROVIDED: Record<string, string> = {
  PORT: 'Cloud Run injects it',
  NODE_ENV: 'the Dockerfile sets it',
};

export interface Mount {
  /** The variable name the container sees. */
  name: string;
  /** For `--set-secrets`, the Secret Manager secret it is mounted from. */
  secret: string | null;
  source: string;
  disabled: boolean;
}

export interface EnvRead {
  name: string;
  file: string;
  line: number;
}

export interface UncheckedRead {
  file: string;
  line: number;
  reason: string;
}

export interface EnvScan {
  reads: EnvRead[];
  unchecked: UncheckedRead[];
}

export interface ConfigReads {
  /** Full names read through `own()`, `ownOrThrow()`, `ownOptional()`. */
  names: string[];
  /** The value of `OWN_PREFIX`, or null when there is none. */
  ownPrefix: string | null;
}

/** Whether a variable name may be mounted or read by this service. */
export function isAllowedName(name: string): boolean {
  return name.startsWith(OWN_PREFIX) || Object.hasOwn(PLATFORM_PROVIDED, name);
}

function parse(text: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** The literal text of a string expression, through `as const` and parens. */
function stringValue(node: ts.Expression): string | undefined {
  let current = node;

  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }

  if (
    ts.isStringLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return current.text;
  }

  return undefined;
}

/**
 * Every `const NAME = 'value'` in a file. A name declared twice with a string
 * maps to null, because which one a read means cannot be told without scopes.
 */
function constStrings(source: ts.SourceFile): Map<string, string | null> {
  const found = new Map<string, string | null>();

  walk(source, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.initializer === undefined ||
      !ts.isVariableDeclarationList(node.parent) ||
      (node.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return;
    }

    const value = stringValue(node.initializer);

    if (value === undefined) return;

    found.set(node.name.text, found.has(node.name.text) ? null : value);
  });

  return found;
}

function isProcessEnv(node: ts.Node): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  );
}

/** Every `process.env` read in one file, and the ones whose name is unknown. */
export function envReadsIn(text: string, file: string): EnvScan {
  const source = parse(text, file);
  const consts = constStrings(source);
  const reads: EnvRead[] = [];
  const unchecked: UncheckedRead[] = [];

  walk(source, (node) => {
    if (!isProcessEnv(node)) return;

    const parent = node.parent;
    const line = lineOf(source, node);
    const read = (name: string): void => {
      reads.push({ name, file, line });
    };
    const skip = (reason: string): void => {
      unchecked.push({ file, line, reason });
    };

    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      read(parent.name.text);
      return;
    }

    if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      const key = parent.argumentExpression;
      const value =
        stringValue(key) ??
        (ts.isIdentifier(key)
          ? (consts.get(key.text) ?? undefined)
          : undefined);

      if (value === undefined) {
        skip(`process.env[${key.getText(source)}]: computed name`);
      } else {
        read(value);
      }
      return;
    }

    if (
      ts.isVariableDeclaration(parent) &&
      parent.initializer === node &&
      ts.isObjectBindingPattern(parent.name)
    ) {
      for (const element of parent.name.elements) {
        const key = element.propertyName ?? element.name;

        if (element.dotDotDotToken !== undefined) {
          skip('the rest of process.env, destructured');
        } else if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
          read(key.text);
        } else {
          skip('process.env destructured with a computed name');
        }
      }
      return;
    }

    skip('process.env used whole');
  });

  return { reads, unchecked };
}

/**
 * The config's prefixing readers: `own`, `ownOrThrow`, `ownOptional`, and any
 * later `ownSomething`. Matched by shape rather than listed, so a new reader
 * cannot make its names invisible to this check.
 */
const OWN_READER = /^own(?:[A-Z]\w*)?$/;

/** The `OWN_PREFIX` and every literal `own*('X')` name in the config. */
export function configReadsIn(text: string, file: string): ConfigReads {
  const source = parse(text, file);
  // A holder rather than a `let`: TypeScript does not see assignments made
  // inside the walk callback, and would narrow a `let` to `null` after it.
  const found: { ownPrefix: string | null } = { ownPrefix: null };
  const suffixes = new Set<string>();

  walk(source, (node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'OWN_PREFIX' &&
      node.initializer !== undefined &&
      found.ownPrefix === null
    ) {
      found.ownPrefix = stringValue(node.initializer) ?? null;
      return;
    }

    if (!ts.isCallExpression(node) || node.arguments.length === 0) return;

    const callee = node.expression;
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : undefined;

    if (calleeName === undefined || !OWN_READER.test(calleeName)) return;

    // A call with a variable name is the plumbing between own() and the
    // readers built on it, not a read of its own.
    const suffix = stringValue(node.arguments[0]);

    if (suffix !== undefined) suffixes.add(suffix);
  });

  const prefix = found.ownPrefix ?? OWN_PREFIX;

  return {
    names: [...suffixes].map((suffix) => `${prefix}${suffix}`),
    ownPrefix: found.ownPrefix,
  };
}

/** The entries in one `--set-secrets` or `--set-env-vars` value. */
export function entriesIn(
  list: string,
  kind: 'secrets' | 'env-vars',
): { name: string; secret: string | null }[] {
  return list
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, ...rest] = entry.split('=');
      const value = rest.join('=').trim();

      return {
        name: name.trim(),
        secret: kind === 'secrets' ? value.split(':')[0].trim() : null,
      };
    });
}

const SET_FLAG = /--set-(secrets|env-vars)[ =]"([^"]*)"/g;

function mountsInLine(
  line: string,
  source: string,
  disabled: boolean,
): Mount[] {
  const found: Mount[] = [];

  for (const match of line.matchAll(SET_FLAG)) {
    const kind = match[1] as 'secrets' | 'env-vars';

    for (const entry of entriesIn(match[2], kind)) {
      found.push({ ...entry, source: `${source} --set-${kind}`, disabled });
    }
  }

  return found;
}

/** The `--set-secrets` and `--set-env-vars` entries of every job. */
export function mountsInWorkflow(
  text: string,
  path: string,
): Map<string, Mount[]> {
  const byJob = new Map<string, Mount[]>();

  let inJobs = false;
  let job: string | null = null;
  let disabled = false;

  for (const line of text.split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }

    if (!inJobs) continue;

    const jobKey = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);

    if (jobKey !== null) {
      job = jobKey[1];
      disabled = false;
      byJob.set(job, byJob.get(job) ?? []);
      continue;
    }

    if (job === null) continue;

    if (/^ {4}if:\s*false\s*$/.test(line)) {
      disabled = true;
    }

    byJob
      .get(job)!
      .push(...mountsInLine(line, `${path} job "${job}"`, disabled));
  }

  return byJob;
}

/** The `--set-*` entries of an operator script under scripts/prod. */
export function mountsInScript(text: string, path: string): Mount[] {
  return text.split(/\r?\n/).flatMap((line) => mountsInLine(line, path, false));
}

export interface CheckInput {
  configPath: string;
  /** Null when the config file does not exist. */
  config: ConfigReads | null;
  mounts: Mount[];
  envReads: EnvRead[];
  unchecked: UncheckedRead[];
  /** Places that mount variables but deploy no known service. */
  unattributed: string[];
}

export interface CheckResult {
  lines: string[];
  failures: number;
}

/** Judge everything that was read. Pure, so the spec can drive it. */
export function evaluate(input: CheckInput): CheckResult {
  const out: string[] = [];
  let failures = 0;

  const section = (title: string, entries: string[], fails: boolean): void => {
    out.push(`   ${fails ? 'FAIL' : 'warn'} ${title}: ${entries.length}`);
    for (const entry of entries) out.push(`        - ${entry}`);
    if (fails) failures += entries.length;
  };

  const at = (read: { file: string; line: number }): string =>
    `${read.file}:${read.line}`;

  const configEnvReads = input.envReads.filter(
    (read) => read.file === input.configPath,
  );
  const readNames = new Set([
    ...(input.config?.names ?? []),
    ...configEnvReads.map((read) => read.name),
  ]);
  const mountedNames = new Set(input.mounts.map((mount) => mount.name));

  const neverRead = input.mounts.filter((mount) => !readNames.has(mount.name));
  const neverMounted = [...readNames]
    .filter((name) => !mountedNames.has(name))
    .sort();

  // Every name, with where it was seen. Reads through own() are listed once
  // as config reads; literal process.env reads come from the scan, with
  // their line.
  const everyName = [
    ...input.mounts.map((mount) => ({ name: mount.name, where: mount.source })),
    ...(input.config?.names ?? []).map((name) => ({
      name,
      where: `${input.configPath} (own)`,
    })),
    ...input.envReads.map((read) => ({ name: read.name, where: at(read) })),
  ];
  const secretSources = input.mounts
    .filter((mount) => mount.secret !== null)
    .map((mount) => ({
      name: mount.secret!,
      where: `${mount.source}, mounted as ${mount.name}`,
    }));

  const foreign = [...everyName, ...secretSources].filter((entry) =>
    entry.name.startsWith(FOREIGN_PREFIX),
  );
  const offList = [
    ...everyName.filter(
      (entry) =>
        !entry.name.startsWith(FOREIGN_PREFIX) && !isAllowedName(entry.name),
    ),
    ...secretSources.filter(
      (entry) =>
        !entry.name.startsWith(FOREIGN_PREFIX) &&
        !entry.name.startsWith(OWN_PREFIX),
    ),
  ];

  out.push('');
  out.push(`== CNC (${input.configPath})`);
  out.push(`   reads:     ${[...readNames].sort().join(', ') || '(nothing)'}`);
  out.push(
    `   mounted:   ${mountedNames.size === 0 ? '(nothing)' : [...mountedNames].sort().join(', ')}`,
  );

  section(
    `0. OWN_PREFIX is not '${OWN_PREFIX}'`,
    input.config === null
      ? [`${input.configPath} does not exist`]
      : input.config.ownPrefix === OWN_PREFIX
        ? []
        : [
            input.config.ownPrefix === null
              ? `${input.configPath} declares no OWN_PREFIX`
              : `${input.configPath} declares OWN_PREFIX = '${input.config.ownPrefix}'`,
          ],
    true,
  );
  section(
    '1. mounted but never read',
    neverRead
      .filter((mount) => !mount.disabled)
      .map((mount) => `${mount.name}  (${mount.source})`),
    true,
  );
  section(
    '1. mounted but never read, in a job that is switched off',
    neverRead
      .filter((mount) => mount.disabled)
      .map((mount) => `${mount.name}  (${mount.source})`),
    false,
  );
  section(
    '2. read but never mounted',
    neverMounted.map((name) =>
      PLATFORM_PROVIDED[name] === undefined
        ? name
        : `${name}  (${PLATFORM_PROVIDED[name]})`,
    ),
    false,
  );
  section(
    `3. foreign prefix ${FOREIGN_PREFIX}`,
    foreign.map((entry) => `${entry.name}  (${entry.where})`),
    true,
  );
  section(
    `4. not ${OWN_PREFIX}*, PORT or NODE_ENV`,
    offList.map((entry) => `${entry.name}  (${entry.where})`),
    true,
  );
  // A failure, not a warning (plan §11): a read through an alias of
  // process.env, or with a computed name, is exactly how an unprefixed setting
  // would slip past rule 4. Outside the config file every read must name its
  // variable literally. Inside it, `own()` builds names from OWN_PREFIX and
  // rule 0 covers that.
  section(
    '5. process.env reads whose name cannot be checked',
    input.unchecked
      .filter((read) => read.file !== input.configPath)
      .map((read) => `${at(read)}  ${read.reason}`),
    true,
  );

  if (input.unattributed.length > 0) {
    out.push('');
    out.push(
      `FAIL mounts in a place that deploys no known service: ${input.unattributed.join('; ')}`,
    );
    failures += input.unattributed.length;
  }

  out.push('');
  out.push(
    failures === 0
      ? 'Result: 0 violations.'
      : `Result: ${failures} violation(s).`,
  );

  return { lines: out, failures };
}

/** Every non-spec .ts file under the scanned directories, repo-relative. */
function filesToScan(root: string): string[] {
  const found: string[] = [];
  const toPosix = (path: string): string =>
    relative(root, path).split(sep).join('/');

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) {
          visit(full);
        }
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts')
      ) {
        found.push(toPosix(full));
      }
    }
  };

  for (const dir of SCAN_DIRS) {
    if (existsSync(join(root, dir))) visit(join(root, dir));
  }

  for (const file of SCAN_FILES) {
    if (existsSync(join(root, file))) found.push(file);
  }

  return found.sort();
}

export function main(root: string = process.cwd()): number {
  const read = (path: string): string => readFileSync(join(root, path), 'utf8');
  const out: string[] = [];
  const mounts: Mount[] = [];
  const unattributed: string[] = [];

  out.push('check:env-names: environment variable names, read against mounted');
  out.push('');
  out.push('Sources:');

  for (const path of WORKFLOWS) {
    if (!existsSync(join(root, path))) {
      out.push(`  ${path}: does not exist yet, not checked`);
      continue;
    }

    out.push(`  ${path}: read`);

    for (const [job, jobMounts] of mountsInWorkflow(read(path), path)) {
      if (!JOB_KEYS.includes(job)) {
        if (jobMounts.length > 0) unattributed.push(`${path} job "${job}"`);
        continue;
      }

      mounts.push(...jobMounts);

      if (jobMounts.some((mount) => mount.disabled)) {
        out.push(`    job "${job}" is switched off (if: false)`);
      }
    }
  }

  // One service, so every operator script that mounts anything mounts CNC.
  if (!existsSync(join(root, PROD_SCRIPTS_DIR))) {
    out.push(`  ${PROD_SCRIPTS_DIR}/*: does not exist yet, not checked`);
  } else {
    for (const file of readdirSync(join(root, PROD_SCRIPTS_DIR)).sort()) {
      const path = `${PROD_SCRIPTS_DIR}/${file}`;
      const found = mountsInScript(read(path), path);

      if (found.length === 0) continue;

      out.push(`  ${path}: read`);
      mounts.push(...found);
    }
  }

  const files = filesToScan(root);
  const envReads: EnvRead[] = [];
  const unchecked: UncheckedRead[] = [];

  for (const file of files) {
    const scan = envReadsIn(read(file), file);
    envReads.push(...scan.reads);
    unchecked.push(...scan.unchecked);
  }

  out.push(
    `  process.env reads: ${files.length} file(s) under ${[...SCAN_DIRS.map((dir) => `${dir}/`), ...SCAN_FILES].join(', ')}, specs skipped`,
  );

  const config = existsSync(join(root, CONFIG_PATH))
    ? configReadsIn(read(CONFIG_PATH), CONFIG_PATH)
    : null;

  const result = evaluate({
    configPath: CONFIG_PATH,
    config,
    mounts,
    envReads,
    unchecked,
    unattributed,
  });

  console.log([...out, ...result.lines].join('\n'));

  return result.failures === 0 ? 0 : 1;
}

if (require.main === module) {
  process.exit(main());
}
