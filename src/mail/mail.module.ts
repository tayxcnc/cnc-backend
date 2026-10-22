import { Module } from '@nestjs/common';
import { CncConfigService } from '../config/cnc.config';
import { MAIL_TRANSPORT, type MailTransport } from './mail-transport';
import { MessageSeal } from './message-seal';
import { OutboundMessagesService } from './outbound-messages.service';
import { RecordingMailTransport } from './recording-mail-transport';
import { ResendMailTransport } from './resend-mail-transport';

/**
 * The process's one transport: recording locally (and in tests), Resend on
 * every deployed environment. See the module note.
 */
export function mailTransportFor(
  config: Pick<CncConfigService, 'cncEnv' | 'resendApiKey' | 'mailFrom'>,
): MailTransport {
  return config.cncEnv === 'local'
    ? new RecordingMailTransport(true)
    : new ResendMailTransport(config);
}

/**
 * CNC's email (plan §9.2, §11): the outbound queue, the mail frame, the
 * templates and the one transport, for any module that sends mail. No
 * controller: mail is something features do, not something the API exposes
 * (the retry sweep's route lives with the other sweeps).
 *
 * **The transport is chosen once, by `CNC_ENV`.** Locally, and in every
 * test run, `RecordingMailTransport` sends nothing and writes the text to
 * the local log, so no real email ever leaves a developer's machine, even
 * one holding a real key. Staging and production use `ResendMailTransport`
 * with CNC's own key; with the key or sender unset or a placeholder it
 * reports itself unconfigured and the queue keeps every message for the
 * retry sweep.
 */
@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [CncConfigService],
      useFactory: mailTransportFor,
    },
    MessageSeal,
    OutboundMessagesService,
  ],
  exports: [OutboundMessagesService, MAIL_TRANSPORT],
})
export class MailModule {}
