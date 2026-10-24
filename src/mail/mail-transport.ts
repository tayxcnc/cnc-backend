/**
 * One message, rendered and framed, ready for a transport. The template
 * owns the words (`mail-templates.ts`), the frame owns the banner
 * (`cnc-mail-frame.ts`), and a transport owns delivery and nothing else:
 * TAY's rule that the feature owns its copy and the transport owns
 * delivery.
 */
export interface OutgoingMail {
  to: string;
  subject: string;
  /** The framed HTML body. */
  html: string;
  /** The plain-text alternative, as composed: there is no banner in text. */
  text: string;
  replyTo?: string;
  /**
   * The same for every attempt at one queued message (its row id), so a
   * provider that honours it delivers a retried message once, even when an
   * earlier attempt's answer was lost.
   */
  idempotencyKey?: string;
}

/**
 * How long a transport waits for the provider's answer before it treats
 * the send as failed (the queue then retries it, under the same
 * idempotency key). Without a limit a hung provider would hold a
 * customer's request (`POST /auth/code` dispatches after its commit) for as
 * long as it hangs. Shorter than the queue's lease on a claimed message
 * (`MESSAGE_SEND_LEASE_MS`).
 */
export const MAIL_SEND_TIMEOUT_MS = 20 * 1000;

/**
 * Where rendered mail goes. Two implementations, chosen once at boot by
 * `CNC_ENV` (`mail.module.ts`):
 *
 * - `ResendMailTransport` on staging and production: CNC's own Resend key.
 * - `RecordingMailTransport` locally and in every test: nothing leaves the
 *   machine, and the messages are kept in memory for a test to read.
 *
 * **`send` resolves on success and throws on any failure, with the
 * provider's reason and never the subject or body in the error.** The
 * outbound queue decides what a failure means (a retry, or giving up); a
 * transport that swallowed failures would report a sign-in code delivered
 * that never was.
 */
export interface MailTransport {
  /**
   * Whether this transport can send at all. False when the key or the
   * sender is unset or a placeholder: the queue then leaves the message
   * waiting for the retry sweep instead of spending an attempt on a send
   * that cannot succeed.
   */
  readonly configured: boolean;

  /**
   * Whether a send reaches a real inbox (Resend), so a message to a
   * reserved domain is given up unsent (`isReservedMailDomain`, C8
   * review). False for the recording transport, whose tests use `.test`
   * addresses.
   */
  readonly deliversToInboxes: boolean;

  send(mail: OutgoingMail): Promise<void>;
}

/** The injection token for the process's one `MailTransport`. */
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
