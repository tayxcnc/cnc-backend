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

  describe('booking emails', () => {
    const booking = {
      number: 'RSV-000007',
      guestName: 'Ada <b>',
      venue: 'Lounge',
      table: 'Sofa setting 1',
      date: 'Sat 24 Oct 2026',
      time: '19:00',
      party: 2,
      phone: '08022188797',
      accountUrl: 'https://tayxcnc.com/cnc/account',
    };

    it('confirms with the details, the 24-hour rule and the phone, escaped in HTML', () => {
      const mail = renderMail('reservation.confirmed', booking);

      expect(mail.subject).toBe('Your table at CNC is booked: RSV-000007');
      expect(mail.text).toContain('Booking: RSV-000007');
      expect(mail.text).toContain('Space: Lounge');
      expect(mail.text).toContain('Date: Sat 24 Oct 2026');
      expect(mail.text).toContain('Arrival: 19:00');
      expect(mail.text).toContain('Party: 2 guests');
      expect(mail.text).toContain(
        'up to 24 hours before it starts. After that, please call CNC on 08022188797.',
      );
      expect(mail.html).toContain('Ada &lt;b&gt;');
      expect(mail.html).not.toContain('Ada <b>');
      expect(mail.html).toContain('href="https://tayxcnc.com/cnc/account"');
    });

    it('says what changed and what was cancelled', () => {
      expect(renderMail('reservation.changed', booking).subject).toBe(
        'Your CNC booking RSV-000007 has changed',
      );

      const cancelled = renderMail('reservation.cancelled', {
        ...booking,
        accountUrl: null,
      });
      expect(cancelled.subject).toBe(
        'Your CNC booking RSV-000007 is cancelled',
      );
      expect(cancelled.text).toContain('Nothing is charged.');
      expect(cancelled.text).not.toContain('Party:');
    });

    it('refuses booking parameters that do not fit', () => {
      for (const params of [
        { ...booking, party: 0 },
        { ...booking, number: '' },
        { ...booking, accountUrl: 3 },
      ]) {
        expect(() => renderMail('reservation.confirmed', params)).toThrow(
          /malformed/,
        );
      }
    });
  });
});
