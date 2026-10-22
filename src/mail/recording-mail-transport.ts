import { Logger } from '@nestjs/common';
import type { MailTransport, OutgoingMail } from './mail-transport';

/**
 * How many recorded messages are kept. A local server left running for
 * days, or a long e2e run, must not grow without bound; the oldest go first.
 */
export const RECORDED_MAIL_LIMIT = 500;

/**
 * The transport used when `CNC_ENV` is `local` (development and every test
 * run): it sends nothing, and keeps each message in memory.
 *
 * **Locally, and only locally, it writes the plain-text body to the log**,
 * so a person walking the sign-in on their machine can read the code from
 * the server's output without a mail account. It is constructed only when
 * `CNC_ENV` is `local` (`mail.module.ts`), and a built container refuses
 * `CNC_ENV=local` at boot (`CncConfigService.cncEnv`), so staging and
 * production can never log a code through here. Every deployed environment
 * uses `ResendMailTransport`, which logs the recipient and the outcome only.
 *
 * Tests read `sent` (through `app.get(MAIL_TRANSPORT)`) instead of a log.
 */
export class RecordingMailTransport implements MailTransport {
  private readonly logger = new Logger('LocalMail');

  /** The messages "sent", oldest first. */
  readonly sent: OutgoingMail[] = [];

  /** Set to false to see how the queue treats an unconfigured transport. */
  configured = true;

  /** Set to make the next sends throw this, as a failing provider would. */
  failWith: Error | undefined;

  /**
   * Set to make each send wait for this promise before it lands, as a slow
   * provider would; a suite races the queue's dispatch against a sweep with
   * it.
   */
  hold: Promise<void> | undefined;

  constructor(private readonly logBodies: boolean) {}

  async send(mail: OutgoingMail): Promise<void> {
    if (this.hold !== undefined) await this.hold;

    return this.record(mail);
  }

  private record(mail: OutgoingMail): Promise<void> {
    if (!this.configured) {
      return Promise.reject(new Error('Mail is not configured.'));
    }

    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }

    this.sent.push(mail);

    if (this.sent.length > RECORDED_MAIL_LIMIT) {
      this.sent.splice(0, this.sent.length - RECORDED_MAIL_LIMIT);
    }

    if (this.logBodies) {
      this.logger.log(
        `Local mail to ${mail.to}, not sent (CNC_ENV is local):\n` +
          `${mail.subject}\n\n${mail.text}`,
      );
    }

    return Promise.resolve();
  }

  /** The newest message to `to`, or undefined. */
  lastTo(to: string): OutgoingMail | undefined {
    for (let index = this.sent.length - 1; index >= 0; index--) {
      if (this.sent[index].to === to) return this.sent[index];
    }

    return undefined;
  }

  /** Every message to `to`, oldest first. */
  allTo(to: string): OutgoingMail[] {
    return this.sent.filter((mail) => mail.to === to);
  }
}
