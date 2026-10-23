import { Injectable } from '@nestjs/common';

const OWN_PREFIX = 'CNC_';
const FOREIGN_PREFIX = 'TAY_';

/**
 * The deployments this service knows about, read from `CNC_ENV`.
 *
 * Deliberately not `NODE_ENV`. See `CncConfigService.cncEnv` for why that
 * variable is not available to say this.
 */
export const CNC_ENVIRONMENTS = ['local', 'staging', 'production'] as const;

export type CncEnv = (typeof CNC_ENVIRONMENTS)[number];

function isCncEnv(value: string): value is CncEnv {
  return (CNC_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * The placeholder values `.env.example` and the deploy runbook use. A secret
 * still holding one was copied, not generated, and is public.
 */
const PLACEHOLDERS = new Set(['CHANGE_ME', 'PLACEHOLDER_NOT_SET']);

/**
 * Whether a configured origin is a bare origin a browser could send
 * (`scheme://host[:port]`, no path, no trailing slash). The CORS check is an
 * exact string match, so anything else can never match.
 */
function isBareOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/**
 * Split a comma-separated origin list, trimming each entry.
 *
 * Trimmed because the secret is edited by hand, and a stray space around a
 * comma would otherwise make that one origin silently stop matching. TAY's
 * config getter split without trimming while its bootstrap trimmed, so the
 * two disagreed; here there is one reader.
 */
function splitOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Configuration for the CNC service, and the only code in this repository that
 * reads the environment, apart from `PORT` and `NODE_ENV`.
 *
 * ## Every setting is CNC_-prefixed
 *
 * CNC's staging service lives in the same Google Cloud project as TAY's, and
 * production will be one joint project. In TAY's backend, a handful of names
 * were read unprefixed (`CORS_ORIGINS`, `MAIL_FROM`, `RESEND_API_KEY`…)
 * because two brands once shared one deployment. Those secrets now belong to
 * TAY. If CNC read the same names, mounting one of them on CNC's service would
 * be a single typo away, and a change TAY made would silently change CNC.
 * Prefixing everything makes CNC's settings unreachable from TAY's names, and
 * `scripts/check-env-names.ts` fails CI on any unprefixed read except `PORT`
 * and `NODE_ENV`.
 *
 * ## TAY's namespace refuses the boot
 *
 * The constructor refuses to boot if any TAY_ variable is present. A CNC
 * container that can see TAY's namespace is a misconfiguration, not a warning:
 * it means the two services' environments have been merged somewhere in the
 * deployment pipeline, and the next thing that happens is CNC reading TAY's
 * database URL.
 *
 * ## Values are never printed
 *
 * Every refusal names the variable and why. None prints a value, because
 * several of these are a database URL, a signing secret or a payment key.
 */
@Injectable()
export class CncConfigService {
  /**
   * Minimum accepted length of CNC_JWT_SECRET, in characters.
   *
   * HS256 keys shorter than the 256-bit hash they feed weaken the signature,
   * and a short secret is the one auth mistake that is invisible in testing:
   * everything signs and verifies correctly right up until someone brute-forces
   * it. `openssl rand -hex 32` produces a 64-character value that clears this.
   */
  static readonly MIN_JWT_SECRET_LENGTH = 32;

  /** Validated once at construction; the getter below just hands it out. */
  private readonly cachedJwtSecret: string;

  constructor() {
    this.assertForeignNamespaceAbsent();
    this.cachedJwtSecret = this.readJwtSecret();
    this.assertDeployedConfiguration();
    this.assertProductionConfiguration();
  }

  /**
   * Which deployment this process is, and the only thing the deployed and
   * production boot rules read.
   *
   * **`NODE_ENV` is not this variable and must not be made into it.** It is a
   * build and runtime flag that Nest reads, and it decides whether the refresh
   * cookie carries `Secure`. Setting `NODE_ENV=staging` on a deployed service
   * would quietly drop `Secure`. TAY learned this the hard way and made the
   * rule: `NODE_ENV` stays exactly what it is on every environment, and a new
   * fact about the deployment gets a new variable.
   *
   * Required wherever `NODE_ENV` is `production` (every built container), with
   * no default, and **never `local` there**: `local` skips the deployed boot
   * rules, so a built container claiming to be local would boot without a
   * sweep token or an origin list. Anywhere else an unset value falls back to
   * `local`. Running the image on a developer's machine therefore means
   * `CNC_ENV=staging` with the staging variables.
   *
   * A refused value is not printed: a secret mounted onto this name by a
   * wrong mapping would otherwise land in the boot log.
   */
  get cncEnv(): CncEnv {
    const raw = this.own('ENV')?.trim();

    if (raw === undefined || raw === '') {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'CNC service refusing to boot: required environment variable ' +
            'CNC_ENV is not set. It must be one of ' +
            `${CNC_ENVIRONMENTS.join(', ')}. It names which deployment this ` +
            'is; NODE_ENV does not, and must not be changed to say so.',
        );
      }

      return 'local';
    }

    if (!isCncEnv(raw)) {
      throw new Error(
        'CNC service refusing to boot: CNC_ENV is not one of ' +
          `${CNC_ENVIRONMENTS.join(', ')}.`,
      );
    }

    if (raw === 'local' && process.env.NODE_ENV === 'production') {
      throw new Error(
        'CNC service refusing to boot: CNC_ENV is local in a production ' +
          'build. A built container is staging or production; local would ' +
          'skip the deployed boot rules.',
      );
    }

    return raw;
  }

  /**
   * The rules that hold on any deployed environment, staging as well as
   * production.
   *
   * Separate from `assertProductionConfiguration` because that one is about
   * values that must be *real* (a live payment key, https origins) and
   * staging's deliberately are not. This is about values that must simply
   * *exist* wherever the service is reachable from the internet. All problems
   * are reported together, so a deploy fixes them in one pass.
   *
   * - **`CNC_SWEEP_TOKEN`.** The sweep routes are guarded by nothing else, and
   *   the guard refuses every call when it is unset. On a deployed service
   *   that is not an open door: it is scheduler jobs failing every night while
   *   the tables they tidy grow. Refusing to boot makes it a deploy-time
   *   failure. Local keeps it optional.
   * - **`CNC_CORS_ORIGINS`.** An empty allowlist answers curl and the health
   *   check perfectly and refuses every browser. That failure looks healthy
   *   from everywhere except a real page, so it is refused at boot on staging
   *   too, not only in production as TAY's backend did.
   */
  private assertDeployedConfiguration(): void {
    if (this.cncEnv === 'local') return;

    const problems: string[] = [];

    const sweepToken = this.own('SWEEP_TOKEN')?.trim();
    if (sweepToken === undefined || sweepToken === '') {
      problems.push(
        'CNC_SWEEP_TOKEN is not set: the sweep routes refuse every call ' +
          'without it, so the scheduled cleanups would fail silently.',
      );
    } else if (
      PLACEHOLDERS.has(sweepToken) ||
      sweepToken.length < CncConfigService.MIN_JWT_SECRET_LENGTH
    ) {
      problems.push(
        'CNC_SWEEP_TOKEN is a placeholder or shorter than ' +
          `${CncConfigService.MIN_JWT_SECRET_LENGTH} characters: it is a ` +
          'bearer credential. Generate one with `openssl rand -hex 32`.',
      );
    }

    const origins = splitOrigins(this.own('CORS_ORIGINS'));
    if (origins.length === 0) {
      problems.push(
        'CNC_CORS_ORIGINS is empty: an empty allowlist rejects every ' +
          'browser origin, so the API would answer curl and no frontend.',
      );
    }

    // A live Paystack key belongs to production alone (C7). Staging takes
    // test-mode money only; a live key there would charge real cards from
    // a service whose gate walks pay with test cards.
    if (
      this.cncEnv !== 'production' &&
      this.own('PAYSTACK_SECRET_KEY')?.trim().startsWith('sk_live_') === true
    ) {
      problems.push(
        'CNC_PAYSTACK_SECRET_KEY is a live key outside production: ' +
          'staging must run on CNC’s test key.',
      );
    }

    // Counted, never printed. A path (`https://tayxcnc.com/cnc` pasted from
    // CNC_WEB_URL) or a trailing slash can never equal a browser's Origin
    // header, so such an entry silently refuses its frontend.
    const malformed = origins.filter((origin) => !isBareOrigin(origin));
    if (malformed.length > 0) {
      problems.push(
        `CNC_CORS_ORIGINS holds ${malformed.length} entr(ies) that are not ` +
          'a bare origin (scheme://host[:port], no path or trailing slash); ' +
          'they can never match.',
      );
    }

    if (problems.length > 0) {
      throw new Error(
        `CNC service refusing to boot in ${this.cncEnv}. ` +
          `${problems.length} configuration problem(s):\n` +
          problems.map((problem) => `  - ${problem}`).join('\n'),
      );
    }
  }

  /**
   * The rules that hold only in production, checked before the server
   * listens.
   *
   * Every rule below is a value that is wrong in a way nothing notices until
   * it costs somebody something. TAY's Phase 2 found the shape of it: a
   * malformed web URL produced a payment callback nobody could follow, and the
   * first sign was a member seeing an error page after paying.
   *
   * Staging and local apply none of them. Staging deliberately runs with a
   * Paystack test key.
   */
  private assertProductionConfiguration(): void {
    if (this.cncEnv !== 'production') return;

    const problems: string[] = [];

    // 1. The web URL. Every link CNC emails and every Paystack callback is
    //    built from it. Unlike TAY's, CNC's base carries its path: the site
    //    is served at tayxcnc.com/cnc, so the value is `https://…/cnc` and
    //    the paths joined to it never repeat `/cnc` (see buildWebUrl).
    const webUrl = this.own('WEB_URL')?.trim();
    if (webUrl === undefined || webUrl === '') {
      problems.push('CNC_WEB_URL is not set.');
    } else if (!webUrl.startsWith('https://')) {
      problems.push('CNC_WEB_URL must begin with https:// in production.');
    } else if (webUrl.endsWith('/')) {
      problems.push(
        'CNC_WEB_URL must not end in a slash: buildWebUrl adds one.',
      );
    } else if (!webUrl.endsWith('/cnc')) {
      problems.push(
        'CNC_WEB_URL must end in /cnc, the base path the site is served ' +
          'under; paths built from it do not repeat it.',
      );
    }

    // 2. The staff app's address, used in staff emails. Same shape rules,
    //    except that the staff app owns its whole origin and has no path.
    const staffUrl = this.own('STAFF_URL')?.trim();
    if (staffUrl === undefined || staffUrl === '') {
      problems.push('CNC_STAFF_URL is not set.');
    } else if (!staffUrl.startsWith('https://')) {
      problems.push('CNC_STAFF_URL must begin with https:// in production.');
    } else if (staffUrl.endsWith('/')) {
      problems.push('CNC_STAFF_URL must not end in a slash.');
    }

    // 3. Every CORS origin. An http origin in the allowlist is a credentialed
    //    cross-site request the browser will make over plaintext.
    const insecure = splitOrigins(this.own('CORS_ORIGINS')).filter(
      (origin) => !origin.startsWith('https://'),
    );
    if (insecure.length > 0) {
      problems.push(
        `CNC_CORS_ORIGINS holds ${insecure.length} origin(s) that are not ` +
          'https:// . Credentials are enabled on this API.',
      );
    }

    // 4. The contact address. Enquiries and payment problems are emailed to
    //    it; unset, the only record is a log line nobody is watching.
    const contact = this.own('CONTACT_EMAIL')?.trim();
    if (contact === undefined || contact === '') {
      problems.push(
        'CNC_CONTACT_EMAIL is not set: enquiries and payment problems ' +
          'would notify nobody.',
      );
    }

    // 5. A live payment key. This keeps a production service from quietly
    //    taking test-mode money. CNC has its own Paystack merchant account;
    //    TAY's keys are never read here.
    const paystack = this.own('PAYSTACK_SECRET_KEY')?.trim();
    if (paystack === undefined || paystack === '') {
      problems.push('CNC_PAYSTACK_SECRET_KEY is not set.');
    } else if (!paystack.startsWith('sk_live_')) {
      problems.push(
        'CNC_PAYSTACK_SECRET_KEY is not a live key: production must not ' +
          'run on a test key. Until Paystack verifies the business this ' +
          'failure is the intended state; do not weaken the rule to boot.',
      );
    }

    // 6. An encrypted database connection. Cloud SQL's socket form goes over
    //    the local connector rather than the network, so it needs no sslmode;
    //    the TCP form does.
    const database = this.own('DB_URL')?.trim();
    if (database === undefined || database === '') {
      problems.push('CNC_DB_URL is not set.');
    } else if (
      !database.includes('sslmode=require') &&
      !database.includes('host=/cloudsql/')
    ) {
      problems.push(
        'CNC_DB_URL must either use the Cloud SQL socket form ' +
          '(host=/cloudsql/…) or require TLS (sslmode=require).',
      );
    }

    if (problems.length > 0) {
      throw new Error(
        'CNC service refusing to boot in production. ' +
          `${problems.length} configuration problem(s):\n` +
          problems.map((problem) => `  - ${problem}`).join('\n'),
      );
    }
  }

  /** Throws; never logs, never warns. The process must refuse to boot. */
  private assertForeignNamespaceAbsent(): void {
    const leaked = Object.keys(process.env)
      .filter((key) => key.startsWith(FOREIGN_PREFIX))
      .sort();

    if (leaked.length > 0) {
      throw new Error(
        `CNC service refusing to boot: found ${leaked.length} ${FOREIGN_PREFIX}-prefixed ` +
          `environment variable(s) in this process: ${leaked.join(', ')}. ` +
          `TAY and CNC are separately-owned businesses and must not share an ` +
          `environment. Remove every ${FOREIGN_PREFIX} variable from this container's ` +
          `configuration.`,
      );
    }
  }

  /**
   * Reads and validates the JWT signing secret. Called once, from the
   * constructor, so the check runs at boot rather than at first sign-in.
   *
   * Throws; never logs, never warns. A service that starts without a usable
   * signing secret looks healthy, passes its liveness probe, and fails only
   * when a real person tries to sign in. Refusing to boot turns that into a
   * deploy-time failure, which is the only time it is cheap to fix.
   */
  private readJwtSecret(): string {
    // Trimmed before the length check, so a value of spaces cannot pass it.
    const secret = this.ownOrThrow('JWT_SECRET').trim();

    if (PLACEHOLDERS.has(secret)) {
      throw new Error(
        'CNC service refusing to boot: CNC_JWT_SECRET is still a placeholder. ' +
          'Generate one with `openssl rand -hex 32`.',
      );
    }

    if (secret.length < CncConfigService.MIN_JWT_SECRET_LENGTH) {
      throw new Error(
        `CNC service refusing to boot: ${OWN_PREFIX}JWT_SECRET is ` +
          `${secret.length} characters, below the required minimum of ` +
          `${CncConfigService.MIN_JWT_SECRET_LENGTH}. Generate one with ` +
          '`openssl rand -hex 32`.',
      );
    }

    return secret;
  }

  /**
   * Read a CNC_-prefixed variable. The prefix is applied here, so callers
   * cannot reach outside the CNC namespace through this method.
   */
  private own(suffix: string): string | undefined {
    return process.env[`${OWN_PREFIX}${suffix}`];
  }

  private ownOrThrow(suffix: string): string {
    const value = this.own(suffix);
    if (value === undefined || value === '') {
      throw new Error(
        'CNC service refusing to boot: required environment variable ' +
          `${OWN_PREFIX}${suffix} is not set.`,
      );
    }
    return value;
  }

  /** An optional own value, undefined when unset or blank. */
  private ownOptional(suffix: string): string | undefined {
    const value = this.own(suffix)?.trim();

    return value === undefined || value === '' ? undefined : value;
  }

  get databaseUrl(): string {
    return this.ownOrThrow('DB_URL');
  }

  /**
   * HS256 signing secret for CNC access tokens.
   *
   * TAY and CNC never share this value. A token signed with TAY's secret must
   * fail verification here outright: that rejection is the auth-layer half of
   * the same isolation guarantee the separate databases provide.
   */
  get jwtSecret(): string {
    return this.cachedJwtSecret;
  }

  /**
   * The exact browser origins allowed to call this API with credentials.
   *
   * Read here and handed to `bootstrap()`, so that `bootstrap.ts` reads no
   * environment variable of its own. TAY's bootstrap read its unprefixed
   * `CORS_ORIGINS` directly; a verbatim copy here would have read an empty
   * list and refused every browser while staying healthy.
   */
  get corsOrigins(): string[] {
    return splitOrigins(this.own('CORS_ORIGINS'));
  }

  /**
   * The shared secret Cloud Scheduler presents to the sweep routes, or
   * undefined where none is configured.
   *
   * Undefined rather than throwing: the sweeps are housekeeping, so a local
   * service without a token runs perfectly well and simply refuses to sweep.
   * On staging and production it cannot be undefined, because
   * `assertDeployedConfiguration` refuses the boot.
   */
  get sweepToken(): string | undefined {
    return this.ownOptional('SWEEP_TOKEN');
  }

  /**
   * A link into the CNC website: the base URL with `path` joined onto it.
   *
   * ## Why one method owns this
   *
   * In TAY's backend five services once built their own links from the base
   * URL, and three of them each guessed a route the frontend did not have. A
   * member returning from a real checkout landed on a 404 having just paid.
   * One method cannot make a caller ask for the right page, but it makes the
   * base URL unreachable except through here, so the joining is decided once.
   *
   * ## The base carries the path
   *
   * CNC's site is served at `tayxcnc.com/cnc`, so `CNC_WEB_URL` is
   * `https://tayxcnc.com/cnc` and callers pass paths **without** `/cnc`:
   * `buildWebUrl('/account')` is `https://tayxcnc.com/cnc/account`. This is
   * the reverse of TAY's convention (an origin, with `/tay` in every path),
   * which is why a copied caller habit would produce `/cnc/cnc/…`.
   *
   * ## What an absent base means is the caller's decision
   *
   * Returns undefined when `CNC_WEB_URL` is unset or blank. A blank base is
   * never joined: a relative path handed to Paystack as a callback resolves
   * against Paystack's own host. Exactly one slash joins the halves, whichever
   * side supplied one.
   */
  buildWebUrl(path: string): string | undefined {
    const base = this.ownOptional('WEB_URL');

    if (base === undefined) {
      return undefined;
    }

    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  /**
   * The staff app's own origin (for example `https://cnc-staff.tayxcnc.com`),
   * used for links in staff emails. Optional: a process that never sends a
   * staff email boots without it.
   */
  get staffUrl(): string | undefined {
    return this.ownOptional('STAFF_URL');
  }

  /**
   * Where enquiries and payment problems are emailed: the business's own
   * inbox. Optional locally; required in production.
   */
  get contactEmail(): string | undefined {
    return this.ownOptional('CONTACT_EMAIL');
  }

  /**
   * CNC's Paystack secret key, from CNC's own merchant account.
   *
   * Read lazily, so the failure lands on the first request that needs it
   * rather than at boot: until C7 there is no payment route, and staging
   * carries `PLACEHOLDER_NOT_SET`. Production checks it at boot (rule 5).
   *
   * Never logged, never returned, and never sent anywhere but Paystack's own
   * API over TLS. It is also what Paystack signs webhooks with, so anyone
   * holding it can forge a payment confirmation.
   */
  get paystackSecretKey(): string {
    return this.ownOrThrow('PAYSTACK_SECRET_KEY');
  }

  /**
   * CNC's Paystack secret key, or undefined when unset, blank or still a
   * placeholder (C7). What the checkout and the webhook read.
   *
   * A placeholder is not a key: staging carries `PLACEHOLDER_NOT_SET`
   * until the founder stores CNC's test key (Q18), and that string is
   * public in `.env.example`. Used as the webhook's signing secret it would
   * let anyone who read the example sign a payment confirmation, so while
   * it is the value both routes refuse with 503 instead. Never logged.
   */
  get paystackKey(): string | undefined {
    return this.ownUnlessPlaceholder('PAYSTACK_SECRET_KEY');
  }

  /**
   * CNC's own Resend API key, or undefined when unset, blank or still a
   * placeholder (C6).
   *
   * A placeholder reads as unset rather than as a key: staging carries
   * `PLACEHOLDER_NOT_SET` until the founder's Resend steps are done, and
   * handing that string to Resend would turn every message into a failed
   * send that burns a retry. Unset, the outbound queue leaves each message
   * waiting for the retry sweep (`OutboundMessagesService`), and no
   * customer's request fails for it. Never logged.
   */
  get resendApiKey(): string | undefined {
    return this.ownUnlessPlaceholder('RESEND_API_KEY');
  }

  /**
   * Sender address for CNC's transactional mail, a bare address or the
   * `CNC <cnc@example.com>` form. Resend delivers to arbitrary recipients only
   * from a domain verified in its dashboard. Undefined when unset, blank or a
   * placeholder, for the reason `resendApiKey` gives.
   */
  get mailFrom(): string | undefined {
    return this.ownUnlessPlaceholder('MAIL_FROM');
  }

  /** An optional own value, undefined when unset, blank or a placeholder. */
  private ownUnlessPlaceholder(suffix: string): string | undefined {
    const value = this.ownOptional(suffix);

    return value === undefined || PLACEHOLDERS.has(value) ? undefined : value;
  }

  /**
   * The Cloud Storage bucket CNC's photos live in. Not a secret: the deploy
   * passes it with `--set-env-vars` so it is visible in the workflow file.
   * Read lazily, so a missing bucket breaks uploads, not the whole service.
   */
  get gcsBucket(): string {
    return this.ownOrThrow('GCS_BUCKET');
  }

  /** Injected by Cloud Run into every container. */
  get port(): number {
    return Number(process.env.PORT ?? 3000);
  }

  get nodeEnv(): string {
    return process.env.NODE_ENV ?? 'development';
  }

  /**
   * Whether the refresh cookies carry `Secure` (A16): on every built
   * container, staging included, and nowhere else.
   *
   * Decided by `NODE_ENV`, never by `cncEnv`: staging runs
   * `NODE_ENV=production` with `CNC_ENV=staging`, so `cncEnv === 'production'`
   * would quietly issue a staging cookie without `Secure`. Local development
   * is plain HTTP, where a `Secure` cookie would never be stored. One getter,
   * with a spec, so the rule has one home and a test that fails when it moves.
   */
  get secureCookies(): boolean {
    return this.nodeEnv === 'production';
  }
}
