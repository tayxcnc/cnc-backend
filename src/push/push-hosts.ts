import { isIP } from 'node:net';

/**
 * The push services a subscription's endpoint may name (C10, D13): Chrome's
 * and Edge's (FCM), Firefox's, Safari's and Windows'.
 *
 * Without a list the CNC service would POST to any address a signed-in
 * person stores: an internal or metadata address, a probe that reads its
 * answer through a push's outcome, and a VAPID token signed for any
 * audience. Checked in the subscribe request (`PushSubscribeRequest`) and
 * again by the sender before every send (`WebPushSender`), so a row written
 * before a host left the list is never contacted.
 *
 * Apple is a suffix because Apple asks allowlists to accept
 * `*.push.apple.com`; Windows' endpoints are `wns2-….notify.windows.com`.
 * A browser on a host missing here gets a visible 400 at subscribe, never
 * silence.
 */
export const PUSH_SERVICE_HOSTS = {
  exact: ['fcm.googleapis.com', 'updates.push.services.mozilla.com'],
  suffixes: ['.push.apple.com', '.notify.windows.com'],
} as const;

/** The subscribe route's refusal for an endpoint off the list. */
export const PUSH_ENDPOINT_MESSAGE =
  "This browser's notification service isn't supported.";

/**
 * Why an endpoint is refused, or null when it names a known push service
 * over https on the default port with no user name or password. A host is
 * never an IP literal or `localhost`, and matches the list exactly or by a
 * suffix on a label boundary (`.push.apple.com` takes `web.push.apple.com`,
 * never `evilpush.apple.com`).
 *
 * The answer never repeats the endpoint: it names a person's device.
 */
export function pushEndpointProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'The endpoint is not a URL.';

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return 'The endpoint is not a URL.';
  }

  if (url.protocol !== 'https:') return 'The endpoint is not https.';
  if (url.username !== '' || url.password !== '') {
    return 'The endpoint carries a user name or password.';
  }
  if (url.port !== '') return 'The endpoint names a port.';

  // `hostname` keeps the brackets of an IPv6 literal.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.replace(/^\[|\]$/g, '');

  if (isIP(bare) !== 0 || host === 'localhost' || host.endsWith('.localhost')) {
    return 'The endpoint names an address, not a push service.';
  }

  const known =
    (PUSH_SERVICE_HOSTS.exact as readonly string[]).includes(host) ||
    PUSH_SERVICE_HOSTS.suffixes.some(
      (suffix) => host.endsWith(suffix) && host.length > suffix.length,
    );

  return known ? null : 'The endpoint is not a known push service.';
}
