/**
 * Whether `CNC_DB_URL` names a development database on this machine, for the
 * scripts that refuse to write anywhere else without a flag of their own.
 *
 * Every seed and script that writes reads this one check, so the rule is
 * changed in one place.
 *
 * ## Local means a loopback host on any port but the Cloud SQL proxy's
 *
 * The check is on the URL rather than on `NODE_ENV`, because `NODE_ENV` is
 * often unset locally and absent is indistinguishable from wrong. A loopback
 * host is not enough on its own: staging is reached from a developer's machine
 * through the Cloud SQL proxy on `localhost:5433` (plan §12.3, migrations), so
 * a URL on that port is staging or production however local its host looks,
 * and a check on the host alone would wave it through.
 *
 * Both spellings of the IPv6 loopback are accepted (`::1`, and `[::1]` as a
 * URL writes it).
 *
 * ## Where the driver will connect, not what the URL's authority says
 *
 * The URL is read with `pg-connection-string`, the parser `pg` itself uses
 * under `PrismaPg` (`createSeedClient`): a `?host=` or `?port=` query
 * parameter overrides the authority. Reading the authority alone would call
 * `postgresql://…@localhost/cnc_db?host=/cloudsql/…` local (the Unix socket
 * form Secret Manager holds) and `…@localhost:5432/cnc_db?port=5433` local
 * too, though `pg` connects to Cloud SQL and to the proxy. A host starting
 * with `/` is a Unix socket directory, never a development database.
 *
 * ## A URL must name its host and port, or the answer is "not local"
 *
 * Where a URL leaves out its host or port, `pg` fills them from `PGHOST` and
 * `PGPORT`. TAY's copy of this check read those two variables too. CNC reads
 * no unprefixed setting (plan A4), and `check:env-names` fails on any read it
 * cannot name, so this check does not consult them. It fails closed instead:
 * a URL with no explicit host and port is not called local, because the
 * connection it makes depends on variables this check does not see. Write
 * `localhost:5432` in a local `CNC_DB_URL`.
 */
import { parse } from 'pg-connection-string';

/** The port the Cloud SQL proxy listens on locally. */
export const CLOUD_SQL_PROXY_PORT = '5433';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export type DatabaseTarget =
  | { kind: 'local'; host: string; port: string }
  | { kind: 'remote'; host: string; port: string }
  | { kind: 'incomplete' }
  | { kind: 'unparsable' };

/** Where a connection string makes `pg` connect, as far as these scripts care. */
export function databaseTarget(databaseUrl: string): DatabaseTarget {
  let parsed: ReturnType<typeof parse>;

  try {
    // `pg` reads a string starting with `/` as a socket path, not a URL, and
    // these scripts take a URL, so anything `URL` cannot read is refused
    // before the driver's parser gets it.
    new URL(databaseUrl);
    parsed = parse(databaseUrl);
  } catch {
    return { kind: 'unparsable' };
  }

  const host = parsed.host ?? '';
  const port = parsed.port ?? '';

  // A socket directory is never this machine's development database, port or
  // no port.
  if (host.startsWith('/')) {
    return { kind: 'remote', host, port: port || '(socket)' };
  }

  if (host === '' || port === '') {
    return { kind: 'incomplete' };
  }

  const local = LOOPBACK_HOSTS.has(host) && port !== CLOUD_SQL_PROXY_PORT;

  return { kind: local ? 'local' : 'remote', host, port };
}

/**
 * Why a script must not run against `databaseUrl`, or `null` when it may.
 *
 * `allowRemoteFlag` names the script's own override, always
 * `CNC_SEED_<X>_ALLOW_REMOTE` (for example `CNC_SEED_MENU_ALLOW_REMOTE`), and
 * `allowRemoteValue` is that variable's value, read by the caller with its
 * literal name (`process.env.CNC_SEED_MENU_ALLOW_REMOTE`) so that
 * `check:env-names` can see it. Only exactly `'true'` permits a remote run, so
 * that permitting one script on staging never permits another.
 */
export function remoteDatabaseRefusal(
  databaseUrl: string,
  allowRemoteFlag: string,
  allowRemoteValue: string | undefined,
): string | null {
  const target = databaseTarget(databaseUrl);

  if (target.kind === 'unparsable') {
    return 'CNC_DB_URL is not a URL this script can parse.';
  }

  if (target.kind === 'local' || allowRemoteValue === 'true') {
    return null;
  }

  if (target.kind === 'incomplete') {
    return (
      'Refusing to run: CNC_DB_URL does not name both a host and a port, so ' +
      'where it connects depends on PGHOST/PGPORT, which this check does not ' +
      `read. Write them out (for example localhost:5432), or set ` +
      `${allowRemoteFlag}=true for the run if a remote database is meant.`
    );
  }

  return (
    `Refusing to run: CNC_DB_URL points at ${target.host}:${target.port}, ` +
    `which is not a local development database` +
    (target.port === CLOUD_SQL_PROXY_PORT
      ? ` (${CLOUD_SQL_PROXY_PORT} is the Cloud SQL proxy).`
      : '.') +
    ` Set ${allowRemoteFlag}=true for the run if that is the database you mean.`
  );
}
