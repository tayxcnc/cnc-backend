import { Logger } from '@nestjs/common';
import { type CreateEmailResponse, Resend } from 'resend';
import type { CncConfigService } from '../config/cnc.config';
import {
  MAIL_SEND_TIMEOUT_MS,
  type MailTransport,
  type OutgoingMail,
} from './mail-transport';

/**
 * Delivery through Resend with CNC's own key, copied from TAY's
 * `MailService` (plan §11) and narrowed to transport.
 *
 * **Nothing here logs the subject, the HTML or the text.** A log line
 * carries the recipient and the outcome. A sign-in code is in the subject
 * and the body, and application logs are shipped off the box and read by
 * people who are not the recipient: a body in a log line is a credential in
 * a log line. TAY's rule, unchanged.
 *
 * **The client is built on first send, never in the constructor.**
 * `new Resend(undefined)` throws, and a missing key must not stop the
 * service booting; it leaves `configured` false, and the outbound queue
 * keeps each message for the retry sweep.
 *
 * The key and the sender are read through `CncConfigService`, which treats
 * a placeholder as unset, so staging's `PLACEHOLDER_NOT_SET` never reaches
 * Resend as a key.
 */
export class ResendMailTransport implements MailTransport {
  private readonly logger = new Logger(ResendMailTransport.name);

  /** Built on first use; see the class note. */
  private client: Resend | undefined;

  constructor(
    private readonly config: Pick<
      CncConfigService,
      'resendApiKey' | 'mailFrom'
    >,
  ) {}

  get configured(): boolean {
    return (
      this.config.resendApiKey !== undefined &&
      this.config.mailFrom !== undefined
    );
  }

  async send(mail: OutgoingMail): Promise<void> {
    const from = this.config.mailFrom;
    const apiKey = this.config.resendApiKey;

    if (from === undefined || apiKey === undefined) {
      throw new Error('Mail is not configured.');
    }

    this.client ??= new Resend(apiKey);

    let result: CreateEmailResponse;

    let timer: NodeJS.Timeout | undefined;

    try {
      result = await Promise.race([
        this.client.emails.send(
          {
            from,
            to: mail.to,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
            replyTo: mail.replyTo,
          },
          mail.idempotencyKey === undefined
            ? undefined
            : { idempotencyKey: mail.idempotencyKey },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Resend did not answer in time.')),
            MAIL_SEND_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (cause) {
      // Thrown rather than returned in `result.error`: the request never
      // got an answer (DNS, TLS, a dead socket, or none within
      // `MAIL_SEND_TIMEOUT_MS`).
      this.logger.error(`Mail to ${mail.to} failed: no response from Resend.`);
      throw new Error('No response from Resend.', { cause });
    } finally {
      clearTimeout(timer);
    }

    if (result.error) {
      // Resend's own text about the request (an unverified sender, a
      // rejected address), never the message, so it may travel in the
      // error for the queue's `lastError`. The log line stays bare.
      this.logger.error(`Mail to ${mail.to} rejected by Resend.`);
      throw new Error(`Rejected by Resend: ${result.error.message}`);
    }

    this.logger.log(`Mail sent to ${mail.to}.`);
  }
}
