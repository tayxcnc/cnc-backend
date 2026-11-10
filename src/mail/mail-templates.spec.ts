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
      phone: '0911 350 0003',
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
        'up to 24 hours before it starts. After that, please call CNC on 0911 350 0003.',
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
        'If you can no longer come, please call CNC on 0911 350 0003. ' +
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

  describe('order emails (C7-6)', () => {
    const receipt = {
      number: 'CNCR-000124',
      guestName: 'Ada <b>',
      whereLabel: 'Delivering to',
      where: '12 Rayfield Road, Rayfield, Jos, Landmark: Opposite the church',
      timing: 'As soon as possible, about 90 minutes',
      card: 'Visa ending 4081',
      lines: [
        { qty: 2, name: 'Jollof Rice', option: '', amount: '₦13,000.00' },
        { qty: 1, name: 'Chapman', option: 'Large', amount: '₦3,500.00' },
      ],
      subtotal: '₦16,500.00',
      vatLabel: 'VAT (7.5%)',
      vat: '₦1,237.50',
      deliveryLabel: 'Delivery, Within Jos',
      delivery: '₦5,000.00',
      total: '₦22,737.50',
      trackUrl: 'https://tayxcnc.com/cnc/account#order/CNCR-000124',
      phone: '0911 350 0003',
    };

    it('writes the receipt as the website’s done screen, escaped in HTML', () => {
      const mail = renderMail('order.receipt', receipt);

      expect(mail.subject).toBe('Your CNC order is in: CNCR-000124');
      expect(mail.text).toContain('Thank you, Ada <b>.');
      expect(mail.text).toContain('Your order is in.');
      expect(mail.text).toContain('Order: CNCR-000124');
      expect(mail.text).toContain(
        'Delivering to: 12 Rayfield Road, Rayfield, Jos, Landmark: Opposite the church',
      );
      expect(mail.text).toContain('Paid with: Visa ending 4081');
      expect(mail.text).toContain('2 × Jollof Rice: ₦13,000.00');
      expect(mail.text).toContain('1 × Chapman (Large): ₦3,500.00');
      expect(mail.text).toContain('VAT (7.5%): ₦1,237.50');
      expect(mail.text).toContain('Delivery, Within Jos: ₦5,000.00');
      expect(mail.text).toContain('Total paid: ₦22,737.50');
      expect(mail.text).toContain(
        'Track this order in your account: ' +
          'https://tayxcnc.com/cnc/account#order/CNCR-000124',
      );
      expect(mail.text).toContain(
        'Questions about your order? Call CNC on 0911 350 0003.',
      );
      expect(mail.html).toContain('Thank you, Ada &lt;b&gt;.');
      expect(mail.html).not.toContain('Ada <b>');
    });

    it('leaves out the card and the account link when there are none', () => {
      const mail = renderMail('order.receipt', {
        ...receipt,
        card: '',
        trackUrl: null,
      });

      expect(mail.text).not.toContain('Paid with');
      expect(mail.text).not.toContain('Track this order');
      expect(mail.html).not.toContain('<a ');
    });

    it('refuses a receipt that does not fit', () => {
      for (const params of [
        { ...receipt, lines: [] },
        {
          ...receipt,
          lines: [{ qty: 0, name: 'x', option: '', amount: '₦1' }],
        },
        { ...receipt, total: '' },
        { ...receipt, trackUrl: '' },
        { ...receipt, card: null },
      ]) {
        expect(() => renderMail('order.receipt', params)).toThrow(/malformed/);
      }
    });

    const status = {
      number: 'CNCR-000124',
      guestName: 'Ada',
      kind: 'ON_THE_WAY',
      place: '12 Rayfield Road, Rayfield, Jos',
      phone: '0911 350 0003',
      trackUrl: null,
    };

    it('says the order is on its way, ready, or cancelled', () => {
      const way = renderMail('order.status', status);

      expect(way.subject).toBe('Your CNC order CNCR-000124 is on its way');
      expect(way.text).toContain(
        'Your order is on its way to 12 Rayfield Road, Rayfield, Jos.',
      );

      const ready = renderMail('order.status', {
        ...status,
        kind: 'READY',
        place: '1 Ahmadu Bello Way, Jos',
      });

      expect(ready.subject).toBe(
        'Your CNC order CNCR-000124 is ready for pickup',
      );
      expect(ready.text).toContain(
        'Your order is ready for pickup at CNC, 1 Ahmadu Bello Way, Jos.',
      );

      const cancelled = renderMail('order.status', {
        ...status,
        kind: 'CANCELLED',
        place: '',
      });

      expect(cancelled.subject).toBe('Your CNC order CNCR-000124 is cancelled');
      expect(cancelled.text).toContain(
        'Your order has been cancelled. CNC will give back what you paid ' +
          'and email you when it has.',
      );
      expect(() =>
        renderMail('order.status', { ...status, kind: 'DELIVERED' }),
      ).toThrow(/malformed/);
    });

    it('says how a refund came back', () => {
      const refund = {
        number: 'CNCR-000124',
        guestName: 'Ada',
        amount: '₦3,225.00',
        method: 'CARD',
        card: 'Visa ending 4081',
        phone: '0911 350 0003',
      };

      const card = renderMail('order.refund', refund);

      expect(card.subject).toBe('Refund for your CNC order CNCR-000124');
      expect(card.text).toContain(
        'CNC has refunded ₦3,225.00 to your card (Visa ending 4081) for ' +
          'order CNCR-000124. It can take some days for your bank to show it.',
      );
      expect(
        renderMail('order.refund', { ...refund, method: 'CASH', card: '' })
          .text,
      ).toContain(
        'CNC has given you back ₦3,225.00 in cash for order CNCR-000124.',
      );
      expect(
        renderMail('order.refund', { ...refund, method: 'TRANSFER', card: '' })
          .text,
      ).toContain(
        'CNC has sent you back ₦3,225.00 by bank transfer for order CNCR-000124.',
      );
      expect(() =>
        renderMail('order.refund', { ...refund, method: 'PAYSTACK' }),
      ).toThrow(/malformed/);
    });
  });
});
