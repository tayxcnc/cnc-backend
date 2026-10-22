import { randomInt } from 'node:crypto';

/**
 * The customer's one-time code (A15), copied from TAY's `sign-up-code.ts`
 * and given CNC's caps.
 *
 * Six digits, drawn with `crypto.randomInt` and zero-padded, so a code that
 * starts with 0 is still six characters and still matches what the person
 * types. A million values is not much against a machine, which is why the
 * code is bounded several ways: it lives ten minutes, five wrong tries spend
 * it, each email can be sent only so many in a window, and each address can
 * ask for only so many. Within those bounds a guesser has five in a million
 * per code, and costs the real person nothing but a resend.
 */
export const OTP_DIGITS = 6;

/** How long a code works, from when it is sent (A15). Ten minutes. */
export const OTP_TTL_MS = 10 * 60 * 1000;

/**
 * How soon the same email may be sent another code (A15, and the account
 * app's `RESEND_AFTER_MS`). Thirty seconds.
 */
export const OTP_RESEND_AFTER_MS = 30 * 1000;

/** Wrong tries a code allows before it is spent (A15, `MAX_ATTEMPTS`). */
export const OTP_MAX_ATTEMPTS = 5;

/**
 * The window the issuance caps count over: TAY's credential window,
 * fifteen minutes, so the 429's "Wait a few minutes" is true.
 */
export const OTP_CAP_WINDOW_MS = 15 * 60 * 1000;

/**
 * Codes one email may be sent in the window, from every address together.
 * Five resends is far more than a person waiting on a slow inbox needs, and
 * it holds the mail one stranger can push into someone else's inbox to
 * twenty an hour. Counted on the stored rows, so it holds across instances.
 */
export const OTP_CONTACT_LIMIT = 5;

/**
 * Codes one client address may ask for in the window, over every email.
 * Higher than the per-email cap because many customers share one address
 * (a mobile carrier's NAT, the venue's Wi-Fi); low enough that one machine
 * cannot use CNC's sender to mail a list of strangers.
 */
export const OTP_ADDRESS_LIMIT = 30;

/** A typed code must look like this before it is compared. */
export const OTP_PATTERN = /^\d{6}$/;

export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
}

/**
 * The address a code was sent to, as the sign-in screen shows it: the first
 * letter of the name, three dots, and the domain (`a•••@example.com`). The
 * account app's `maskContact`, byte for byte, for email.
 */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');

  return `${user.slice(0, 1)}•••@${domain}`;
}
