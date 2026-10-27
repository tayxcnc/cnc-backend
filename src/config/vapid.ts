import { createECDH } from 'node:crypto';

/**
 * The VAPID key pair and contact that sign every web push CNC sends (C10),
 * read and checked for `CncConfigService`. Copied from TAY's `vapid.ts` and
 * adapted.
 *
 * ## CNC's own pair, under CNC_ names
 *
 * TAY reads its pair unprefixed (`VAPID_*`); CNC never reads those, nor any
 * `TAY_*` value (*Configuration* in `docs/conventions.md`). Each deployment
 * generates its own pair: a leaked staging key cannot push to production
 * devices. A push subscription is bound to the application server key it
 * was made with (W3C Push API §7.1).
 *
 * **Changing the pair later costs every subscriber**: each existing
 * subscription stops working until the device subscribes again, and on iOS
 * a person can only grant permission from the installed app. So a malformed
 * value refuses to boot rather than being discovered at the first push.
 *
 * **Changed from TAY: the pair must match.** The private key must derive the
 * public key. Two secrets swapped between environments, or a public key from
 * one pair beside the private key of another, pass every length check and
 * then fail with 403 at every push service, on every device, while each
 * device's control still says "On".
 *
 * Neither this file nor its callers ever print a value: the private key is a
 * credential, and an error names the variable and the rule it broke.
 *
 * This file imports no config service; `CncConfigService` imports it.
 */

/** The three names, in the order the deploy mounts them. */
export const VAPID_KEYS = [
  'CNC_VAPID_PUBLIC_KEY',
  'CNC_VAPID_PRIVATE_KEY',
  'CNC_VAPID_SUBJECT',
] as const;

export type VapidKey = (typeof VAPID_KEYS)[number];

export interface VapidDetails {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** An uncompressed P-256 point: 0x04, then 32 bytes of x and 32 of y. */
const PUBLIC_KEY_BYTES = 65;

/** A P-256 private scalar. */
const PRIVATE_KEY_BYTES = 32;

/**
 * URL-safe base64 with optional padding: what a subscribe accepts for a
 * browser's keys and the key it subscribed with, which some encoders pad.
 */
export const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * URL-safe base64 without padding, as `web-push generate-vapid-keys` writes
 * it: the VAPID pair's own rule. web-push's `setVapidDetails` refuses a
 * padded key, so passing one here would fail the boot later, inside
 * `PushModule`, with web-push's words instead of this file's.
 */
const VAPID_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * How many bytes a URL-safe base64 value decodes to, or null when it is not
 * URL-safe base64. Shared with the subscribe route's key checks.
 */
export function base64UrlBytes(value: string): number | null {
  if (!BASE64URL.test(value)) {
    return null;
  }

  return Buffer.from(value, 'base64url').length;
}

function isLocalHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '');

  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower === '127.0.0.1' ||
    lower === '[::1]' ||
    lower === '::1'
  );
}

/** Why a subject is refused, or null when it is usable. */
function subjectProblem(subject: string): string | null {
  if (subject.startsWith('mailto:')) {
    const address = subject.slice('mailto:'.length);
    const at = address.lastIndexOf('@');

    if (at <= 0 || at === address.length - 1) {
      return 'CNC_VAPID_SUBJECT must be a mailto: address with a domain.';
    }

    return isLocalHost(address.slice(at + 1))
      ? 'CNC_VAPID_SUBJECT must not name localhost: push services reject it.'
      : null;
  }

  if (subject.startsWith('https:')) {
    let host: string;

    try {
      host = new URL(subject).hostname;
    } catch {
      return 'CNC_VAPID_SUBJECT is not a valid https: URL.';
    }

    return isLocalHost(host)
      ? 'CNC_VAPID_SUBJECT must not name localhost: push services reject it.'
      : null;
  }

  return 'CNC_VAPID_SUBJECT must begin mailto: or https:.';
}

/**
 * Whether `privateKey` derives `publicKey` on P-256. False, rather than a
 * throw, for a scalar the curve refuses (zero, or past the group order).
 */
function isPair(publicKey: string, privateKey: string): boolean {
  try {
    const curve = createECDH('prime256v1');

    curve.setPrivateKey(Buffer.from(privateKey, 'base64url'));

    return curve.getPublicKey().equals(Buffer.from(publicKey, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * The trio as read, checked; null when none of the three is set.
 *
 * The caller reads each name itself, with its own `ownOptional('VAPID_…')`,
 * so the names appear literally in the config, which is what
 * `scripts/check-env-names.ts` reads to know what the service reads.
 *
 * Throws, naming the service and the variable, when only some are set, when
 * any is malformed (`PLACEHOLDER_NOT_SET` among them), or when the private
 * key does not derive the public key. Whether an unset trio is acceptable
 * is the caller's decision, not this function's.
 */
export function readVapid(
  service: 'CNC',
  raw: Record<VapidKey, string | undefined>,
): VapidDetails | null {
  const [publicKey, privateKey, subject] = VAPID_KEYS.map((key) => {
    const value = raw[key]?.trim();

    return value === undefined || value === '' ? undefined : value;
  });

  const present = [publicKey, privateKey, subject].filter(
    (value) => value !== undefined,
  ).length;

  if (present === 0) {
    return null;
  }

  const refuse = (problem: string): never => {
    throw new Error(
      `${service} service refusing to boot: ${problem} A push subscription ` +
        'made with one key pair never works with another, so a wrong value ' +
        'is refused here rather than found at the first push.',
    );
  };

  if (
    publicKey === undefined ||
    privateKey === undefined ||
    subject === undefined
  ) {
    const missing = VAPID_KEYS.filter(
      (_key, index) => [publicKey, privateKey, subject][index] === undefined,
    );

    return refuse(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set, ` +
        'but the other VAPID values are. Set all three or none.',
    );
  }

  for (const [name, value] of [
    ['CNC_VAPID_PUBLIC_KEY', publicKey],
    ['CNC_VAPID_PRIVATE_KEY', privateKey],
  ] as const) {
    // Well formed but padded: the one malformation worth its own sentence,
    // because the value is otherwise right and only the "=" must go.
    if (BASE64URL.test(value) && !VAPID_KEY.test(value)) {
      refuse(
        `${name} must be URL-safe base64 without "=" padding: web-push ` +
          'refuses a padded key.',
      );
    }
  }

  if (base64UrlBytes(publicKey) !== PUBLIC_KEY_BYTES) {
    refuse(
      'CNC_VAPID_PUBLIC_KEY must be URL-safe base64 of ' +
        `${PUBLIC_KEY_BYTES} bytes.`,
    );
  }

  if (base64UrlBytes(privateKey) !== PRIVATE_KEY_BYTES) {
    refuse(
      'CNC_VAPID_PRIVATE_KEY must be URL-safe base64 of ' +
        `${PRIVATE_KEY_BYTES} bytes.`,
    );
  }

  if (!isPair(publicKey, privateKey)) {
    refuse(
      'CNC_VAPID_PRIVATE_KEY does not match CNC_VAPID_PUBLIC_KEY: the two ' +
        'come from different key pairs, so every push service would refuse ' +
        'every push.',
    );
  }

  const problem = subjectProblem(subject);

  if (problem !== null) {
    refuse(problem);
  }

  return { publicKey, privateKey, subject };
}
