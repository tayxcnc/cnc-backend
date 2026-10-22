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
      // As `ReservationMail` passes it: the site's form (`phoneForDisplay`).
      phone: '0802 218 8797',
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
        'up to 24 hours before it starts. After that, please call CNC on 0802 218 8797.',
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

    it('reminds with the website’s words, the date and time, and whom to call', () => {
      const mail = renderMail('reservation.reminder', booking);

      expect(mail.subject).toBe('See you soon at CNC: RSV-000007');
      expect(mail.text).toContain(
        'Your table in the Lounge is booked for Sat 24 Oct 2026 at 19:00. ' +
          'Your table is yours for your whole visit.',
      );
      expect(mail.text).toContain('Party: 2 guests');
      expect(mail.text).toContain(
        'If you can no longer come, please call CNC on 0802 218 8797. ' +
          'Nothing is charged.',
      );
      // Inside 24 hours the account can no longer change it.
      expect(mail.text).not.toContain('change or cancel');
      expect(mail.html).toContain('Hello Ada &lt;b&gt;,');
      expect(mail.replyTo).toBeUndefined();
    });
  });

  describe('enquiry emails', () => {
    const contact = {
      name: 'Ada <script>',
      email: 'ada@example.com',
      subject: 'Dining\nenquiry',
      message: 'Line one\n<b>Line two</b>',
    };
    const group = {
      name: 'Bola',
      phone: '08031234567',
      email: 'bola@example.com',
      venue: 'Lounge',
      date: 'Sat 24 Oct 2026',
      guests: '8 guests',
      message: '',
    };

    it('forwards a contact enquiry with Reply-To the sender, every value escaped, the subject on one line', () => {
      const mail = renderMail('enquiry.contact', contact);

      expect(mail.subject).toBe('CNC enquiry: Dining enquiry');
      expect(mail.replyTo).toBe('ada@example.com');
      expect(mail.html).toContain('Ada &lt;script&gt;');
      expect(mail.html).not.toContain('<script>');
      expect(mail.html).toContain(
        'white-space:pre-wrap;">Line one\n&lt;b&gt;Line two&lt;/b&gt;</p>',
      );
      expect(mail.text).toContain('Name: Ada <script>');
      expect(mail.text).toContain('Line one\n<b>Line two</b>');
    });

    it('forwards a large-group request; Reply-To only when an email was given', () => {
      const withEmail = renderMail('enquiry.group', group);

      expect(withEmail.subject).toBe(
        'CNC large group: 8 guests in the Lounge on Sat 24 Oct 2026',
      );
      expect(withEmail.replyTo).toBe('bola@example.com');
      expect(withEmail.text).toContain('Phone: 08031234567');
      expect(withEmail.text).toContain('Email: bola@example.com');

      const withoutEmail = renderMail('enquiry.group', {
        ...group,
        email: null,
        message: 'A birthday',
      });

      expect(withoutEmail.replyTo).toBeUndefined();
      expect(withoutEmail.text).not.toContain('Email:');
      expect(withoutEmail.text).toContain('A birthday');
      expect(withoutEmail.text).toContain(
        'Call the guest back on the number above to arrange the tables.',
      );
    });

    it('refuses enquiry parameters that do not fit', () => {
      for (const params of [
        { ...contact, email: '' },
        { ...contact, message: 3 },
        {},
      ]) {
        expect(() => renderMail('enquiry.contact', params)).toThrow(
          /malformed/,
        );
      }

      for (const params of [
        { ...group, phone: '' },
        { ...group, email: '' },
        { ...group, message: null },
      ]) {
        expect(() => renderMail('enquiry.group', params)).toThrow(/malformed/);
      }
    });
  });
});
