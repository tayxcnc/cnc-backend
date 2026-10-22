import { isMailTemplateName, renderMail } from './mail-templates';

describe('mail templates', () => {
  it('renders the sign-in code mail with the code and its lifetime', () => {
    const mail = renderMail('customer.sign-in-code', {
      code: '042817',
      minutes: 10,
    });

    expect(mail.subject).toBe('042817 is your CNC sign-in code');
    expect(mail.html).toContain('>042817</p>');
    expect(mail.html).toContain('It stops working in 10 minutes.');
    expect(mail.text).toContain('    042817');
    expect(mail.text).toContain('It stops working in 10 minutes.');
  });

  it('refuses parameters that do not fit, rather than sending half a mail', () => {
    for (const params of [
      undefined,
      null,
      {},
      { code: '42817', minutes: 10 },
      { code: '<b>1</b>', minutes: 10 },
      { code: '042817', minutes: 0 },
      { code: '042817', minutes: '10' },
      ['042817', 10],
    ]) {
      expect(() => renderMail('customer.sign-in-code', params)).toThrow(
        /malformed/,
      );
    }
  });

  it('refuses an unknown template', () => {
    expect(isMailTemplateName('customer.sign-in-code')).toBe(true);
    expect(isMailTemplateName('toString')).toBe(false);
    expect(() => renderMail('no.such.template', {})).toThrow(
      'Unknown mail template "no.such.template".',
    );
  });
});
