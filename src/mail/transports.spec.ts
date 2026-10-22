import { Logger } from '@nestjs/common';
import type { CncConfigService } from '../config/cnc.config';
import { mailTransportFor } from './mail.module';
import type { OutgoingMail } from './mail-transport';
import {
  RECORDED_MAIL_LIMIT,
  RecordingMailTransport,
} from './recording-mail-transport';
import { ResendMailTransport } from './resend-mail-transport';

const mail = (to: string, text = 'Your code is 042817'): OutgoingMail => ({
  to,
  subject: '042817 is your CNC sign-in code',
  html: '<p>042817</p>',
  text,
});

describe('RecordingMailTransport', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps each message, newest last, and finds them by recipient', async () => {
    const transport = new RecordingMailTransport(false);

    await transport.send(mail('a@cnc.test', 'first'));
    await transport.send(mail('b@cnc.test'));
    await transport.send(mail('a@cnc.test', 'second'));

    expect(transport.lastTo('a@cnc.test')?.text).toBe('second');
    expect(transport.allTo('a@cnc.test').map((m) => m.text)).toEqual([
      'first',
      'second',
    ]);
    expect(transport.lastTo('c@cnc.test')).toBeUndefined();
  });

  it('logs the body only when asked to (CNC_ENV local), and never otherwise', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    await new RecordingMailTransport(false).send(mail('quiet@cnc.test'));
    expect(log).not.toHaveBeenCalled();

    await new RecordingMailTransport(true).send(mail('loud@cnc.test'));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('042817');
    expect(String(log.mock.calls[0][0])).toContain('not sent');
  });

  it('keeps at most RECORDED_MAIL_LIMIT messages, dropping the oldest', async () => {
    const transport = new RecordingMailTransport(false);

    for (let index = 0; index <= RECORDED_MAIL_LIMIT; index++) {
      await transport.send(mail(`n${index}@cnc.test`));
    }

    expect(transport.sent).toHaveLength(RECORDED_MAIL_LIMIT);
    expect(transport.lastTo('n0@cnc.test')).toBeUndefined();
  });

  it('fails as a provider would when told to', async () => {
    const transport = new RecordingMailTransport(false);
    transport.failWith = new Error('Rejected by Resend: test');

    await expect(transport.send(mail('a@cnc.test'))).rejects.toThrow(
      'Rejected by Resend: test',
    );
    expect(transport.sent).toHaveLength(0);
  });
});

describe('mailTransportFor', () => {
  const env = (cncEnv: 'local' | 'staging' | 'production') =>
    ({
      cncEnv,
      resendApiKey: 're_x',
      mailFrom: 'CNC <cnc@x.example>',
    }) as const;

  it('records locally, even with a real key, so no local run sends mail', () => {
    expect(mailTransportFor(env('local'))).toBeInstanceOf(
      RecordingMailTransport,
    );
  });

  it('sends through Resend on staging and production', () => {
    expect(mailTransportFor(env('staging'))).toBeInstanceOf(
      ResendMailTransport,
    );
    expect(mailTransportFor(env('production'))).toBeInstanceOf(
      ResendMailTransport,
    );
  });
});

describe('ResendMailTransport', () => {
  const configWith = (resendApiKey?: string, mailFrom?: string) =>
    ({ resendApiKey, mailFrom }) as unknown as CncConfigService;

  it('is configured only with both a key and a sender', () => {
    expect(new ResendMailTransport(configWith()).configured).toBe(false);
    expect(new ResendMailTransport(configWith('re_x')).configured).toBe(false);
    expect(
      new ResendMailTransport(configWith(undefined, 'CNC <cnc@x.example>'))
        .configured,
    ).toBe(false);
    expect(
      new ResendMailTransport(configWith('re_x', 'CNC <cnc@x.example>'))
        .configured,
    ).toBe(true);
  });

  it('refuses to send unconfigured, without reaching Resend', async () => {
    await expect(
      new ResendMailTransport(configWith()).send(mail('a@cnc.test')),
    ).rejects.toThrow('Mail is not configured.');
  });
});
