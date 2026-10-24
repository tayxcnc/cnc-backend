/**
 * Where the C8-4 load test may run (`docs/load-testing.md`): a backend
 * started on this machine, or CNC staging when the founder names it
 * twice. Never anywhere else, production included: the test creates staff
 * accounts and settles cash bills that, as money records, are never
 * deleted.
 */

/** The one deployed origin the load test may reach. */
export const CNC_STAGING_LOAD_HOST = 'api-cnc-staging.tayxcnc.com';

/** A backend on this machine. `URL.hostname` keeps IPv6's brackets. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Every base URL, parsed, or a thrown error that says why the run is
 * refused. `confirmStaging` is `CNC_LOAD_CONFIRM_STAGING`: it must be
 * exactly the staging host for a staging URL to be accepted, so a host
 * copied from the docs and edited by mistake never reaches anything.
 * Spoofed client addresses are for a local backend only: on staging they
 * would let the website guests past the per-address limits a real guest
 * meets.
 */
export function checkLoadTargets(
  baseUrls: readonly string[],
  options: { confirmStaging: string | undefined; spoofAddresses: boolean },
): string[] {
  if (baseUrls.length === 0) {
    throw new Error('Set CNC_LOAD_BASE_URLS to at least one origin.');
  }

  return baseUrls.map((raw) => {
    let url: URL;

    try {
      url = new URL(raw);
    } catch {
      throw new Error(`Not a URL: ${raw}`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Not an http or https origin: ${raw}`);
    }

    const host = url.hostname.toLowerCase();

    if (LOCAL_HOSTS.has(host)) return url.origin;

    if (host !== CNC_STAGING_LOAD_HOST) {
      throw new Error(
        `Refused: ${host} is neither a local backend nor CNC staging. The ` +
          'load test never runs anywhere else, production included.',
      );
    }

    if (url.protocol !== 'https:') {
      throw new Error(`CNC staging is reached over https only: ${raw}`);
    }

    if (options.confirmStaging !== CNC_STAGING_LOAD_HOST) {
      throw new Error(
        `Refused: to run against CNC staging, follow docs/load-testing.md ` +
          `and set CNC_LOAD_CONFIRM_STAGING=${CNC_STAGING_LOAD_HOST}.`,
      );
    }

    if (options.spoofAddresses) {
      throw new Error(
        'Refused: CNC_LOAD_SPOOF_ADDRESSES is for a local backend only.',
      );
    }

    return url.origin;
  });
}

/**
 * How long a virtual user waits after a refused or failed step before its
 * next one: the server's `Retry-After` (a 429, or the busy database's 503
 * with 2 s), else one second. Retrying at once would multiply the load at
 * the moment the database is struggling.
 */
export function backoffMs(retryAfter: string | null): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds, 60) * 1000;
  }

  return 1000;
}
