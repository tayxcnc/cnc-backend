/**
 * The bucket every unidentifiable caller shares. See `clientAddressOf`.
 */
export const UNKNOWN_ADDRESS = 'unknown';

/**
 * The two things a request has to offer about where it came from. Typed
 * loosely on purpose: a throttler guard hands over a bare record, a parameter
 * decorator hands over an Express request, and both carry these two
 * properties under these two names.
 */
export interface AddressedRequest {
  headers?: unknown;
  ip?: unknown;
}

/**
 * The address a request came from, as far as this service can tell.
 *
 * On Cloud Run every request arrives through Google's load balancer, so
 * `req.ip` is the balancer for every visitor on earth. The `X-Forwarded-For`
 * header arrives as `<client>, <load-balancer>`, appended left to right as the
 * request passes through each hop. A client that sends its own
 * X-Forwarded-For has that value PREPENDED, so the untrusted part of the chain
 * is at the front and the trustworthy part at the back. Taking the first entry
 * would let a caller choose their own address by sending a different fake each
 * time. The last entry is the balancer itself. The second from last is the
 * address the balancer observed the connection coming from, which is the
 * closest thing to the truth available here.
 *
 * "Closest thing to the truth" is doing real work in that sentence. A
 * determined attacker with a botnet, or with access to anything that appends
 * to this header before Google does, can still spread requests across
 * addresses. That is why a rate limit is never the only defence on a public
 * form, and why an audit row's address is evidence rather than proof.
 *
 * Two callers, one rule. The rate limiter buckets on it, and the audit writer
 * stamps it on every audit row. They share this function so that the address
 * a limit was counted against and the address an audit row records cannot be
 * two different ideas of who the caller was.
 *
 * No header at all means local development or a direct connection, where
 * `req.ip` is genuinely the caller. Nothing usable at all returns
 * `UNKNOWN_ADDRESS` rather than an empty string: for the throttler that fails
 * closed — every unidentifiable caller shares one bucket — and for the audit
 * log it is a value that says what happened rather than a null that says
 * nothing was tried.
 */
export function clientAddressOf(req: AddressedRequest): string {
  const headers =
    typeof req.headers === 'object' && req.headers !== null
      ? (req.headers as Record<string, unknown>)
      : undefined;
  const forwarded = headers?.['x-forwarded-for'];

  // Node lower-cases header names, and repeats the header as an array when it
  // appeared more than once. Joining puts the hops back in wire order.
  const chain = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;

  if (typeof chain === 'string' && chain.trim() !== '') {
    const hops = chain
      .split(',')
      .map((hop) => hop.trim())
      .filter((hop) => hop !== '');

    if (hops.length > 0) {
      // Second from last where there is a proxy chain; the only entry when
      // there is a single hop, which is neither the Cloud Run shape nor the
      // local one but is cheap to handle correctly.
      return hops[Math.max(0, hops.length - 2)];
    }
  }

  const directIp = typeof req.ip === 'string' ? req.ip : '';

  return directIp === '' ? UNKNOWN_ADDRESS : directIp;
}
