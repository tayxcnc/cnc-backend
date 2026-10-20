import { databaseTarget, remoteDatabaseRefusal } from './local-database';

/**
 * The check the writing scripts run before they connect: a loopback host on
 * any port but the Cloud SQL proxy's is local; anything else, including a URL
 * that leaves its host or port to PGHOST/PGPORT, needs the script's own flag.
 */
describe('databaseTarget', () => {
  it.each([
    ['postgresql://u:p@localhost:5432/cnc_db', 'localhost', '5432'],
    ['postgresql://u:p@127.0.0.1:5432/cnc_db', '127.0.0.1', '5432'],
    ['postgresql://u:p@[::1]:5432/cnc_db', '[::1]', '5432'],
    // A query parameter naming the loopback is still the loopback.
    [
      'postgresql://u:p@db.example.test:5432/cnc_db?host=localhost',
      'localhost',
      '5432',
    ],
  ])('%s is local', (url, host, port) => {
    expect(databaseTarget(url)).toEqual({ kind: 'local', host, port });
  });

  it.each([
    // The Cloud SQL proxy: staging, however local the host looks.
    ['postgresql://u:p@localhost:5433/cnc_db', 'localhost', '5433'],
    ['postgresql://u:p@127.0.0.1:5433/cnc_db', '127.0.0.1', '5433'],
    ['postgresql://u:p@db.example.test:5432/cnc_db', 'db.example.test', '5432'],
    // `pg` connects where `?port=` and `?host=` say, not where the authority
    // does: the proxy, a remote host.
    ['postgresql://u:p@localhost:5432/cnc_db?port=5433', 'localhost', '5433'],
    [
      'postgresql://u:p@localhost:5432/cnc_db?host=10.1.2.3',
      '10.1.2.3',
      '5432',
    ],
  ])('%s is remote', (url, host, port) => {
    expect(databaseTarget(url)).toEqual({ kind: 'remote', host, port });
  });

  it.each([
    // Secret Manager's Unix socket form, port or no port.
    'postgresql://u:p@localhost/cnc_db?host=/cloudsql/proj:region:inst',
    // A socket directory written into the authority, percent-encoded.
    'postgresql://u:p@%2Fcloudsql%2Fproj/cnc_db',
  ])('%s, a socket directory, is remote', (url) => {
    expect(databaseTarget(url).kind).toBe('remote');
  });

  it.each([
    // No port: pg would take PGPORT, which this check does not read.
    'postgresql://u:p@localhost/cnc_db',
    // No host: pg would take PGHOST.
    'postgresql:///cnc_db',
  ])('%s, which leaves pg to the environment, is incomplete', (url) => {
    expect(databaseTarget(url)).toEqual({ kind: 'incomplete' });
  });

  it.each(['not a url', '/cloudsql/proj:region:inst cnc_db'])(
    'cannot read %p, which is not a URL',
    (value) => {
      expect(databaseTarget(value)).toEqual({ kind: 'unparsable' });
    },
  );
});

describe('remoteDatabaseRefusal', () => {
  const FLAG = 'CNC_SEED_MENU_ALLOW_REMOTE';
  const REMOTE = 'postgresql://u:p@db.example.test:5432/cnc_db';
  const PROXY = 'postgresql://u:p@localhost:5433/cnc_db';

  it('lets a local database through with no flag', () => {
    expect(
      remoteDatabaseRefusal(
        'postgresql://u:p@localhost:5432/cnc_db',
        FLAG,
        undefined,
      ),
    ).toBeNull();
  });

  it('refuses a remote host without the flag, naming the host and the flag', () => {
    expect(remoteDatabaseRefusal(REMOTE, FLAG, undefined)).toBe(
      'Refusing to run: CNC_DB_URL points at db.example.test:5432, which is ' +
        'not a local development database. Set CNC_SEED_MENU_ALLOW_REMOTE=true ' +
        'for the run if that is the database you mean.',
    );
  });

  it('refuses the Cloud SQL proxy on localhost without the flag, and says why', () => {
    expect(remoteDatabaseRefusal(PROXY, FLAG, undefined)).toBe(
      'Refusing to run: CNC_DB_URL points at localhost:5433, which is not a ' +
        'local development database (5433 is the Cloud SQL proxy). Set ' +
        'CNC_SEED_MENU_ALLOW_REMOTE=true for the run if that is the database ' +
        'you mean.',
    );
  });

  it('refuses a URL with no explicit port, and says how to fix it', () => {
    expect(
      remoteDatabaseRefusal(
        'postgresql://u:p@localhost/cnc_db',
        FLAG,
        undefined,
      ),
    ).toMatch(/does not name both a host and a port/);
  });

  it.each([
    'postgresql://u:p@localhost/cnc_db?host=/cloudsql/proj:region:inst',
    'postgresql://u:p@localhost:5432/cnc_db?port=5433',
    'postgresql://u:p@localhost:5432/cnc_db?host=10.1.2.3',
  ])(
    'refuses %s, whose query string sends pg elsewhere, without the flag',
    (url) => {
      expect(remoteDatabaseRefusal(url, FLAG, undefined)).toMatch(
        /^Refusing to run: CNC_DB_URL points at /,
      );
    },
  );

  it('lets a remote database through with the flag set to exactly true', () => {
    expect(remoteDatabaseRefusal(REMOTE, FLAG, 'true')).toBeNull();
    expect(remoteDatabaseRefusal(PROXY, FLAG, 'true')).toBeNull();
  });

  it.each(['1', 'yes', 'TRUE', ''])('does not read %p as the flag', (value) => {
    expect(remoteDatabaseRefusal(REMOTE, FLAG, value)).not.toBeNull();
  });

  it('refuses a URL it cannot read, flag or not', () => {
    expect(remoteDatabaseRefusal('not a url', FLAG, 'true')).toBe(
      'CNC_DB_URL is not a URL this script can parse.',
    );
  });
});
