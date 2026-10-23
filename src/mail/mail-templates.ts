/**
 * The words of every email CNC sends, by template name.
 *
 * An `OutboundMessage` stores its template's name and its (sealed)
 * parameters, never a rendered body, so a message is rendered when it is
 * sent: by the request that queued it, or later by the retry sweep. A
 * template's parameters are therefore checked by a guard when they are read
 * back, not trusted because the same code wrote them.
 *
 * Add a template here with its parameter type in `MailTemplateParams`.
 * Every caller-supplied value goes through `escapeHtml` in the HTML; the
 * plain text is sent as composed.
 */
import { escapeHtml } from './escape-html';

/** What a template produces. The HTML is framed by the queue. */
export interface RenderedMail {
  subject: string;
  /** The body, escaped, without the frame. */
  html: string;
  text: string;
  /**
   * Where a reply goes, when the template knows better than the default
   * (`CNC_CONTACT_EMAIL`): an enquiry's sender, so CNC answers them by
   * pressing Reply.
   */
  replyTo?: string;
}

/** Each template's parameters. */
export interface MailTemplateParams {
  /** A customer's sign-in code (A15). */
  'customer.sign-in-code': { code: string; minutes: number };
  /** The code that proves a customer holds the new email (C6-3). */
  'customer.email-change-code': { code: string; minutes: number };
  /**
   * The notice to the old address once the email has changed (C6-3), with
   * the new address masked as the sign-in screen masks it.
   */
  'customer.email-changed': { newEmailMasked: string };
  /** A booking made, from any channel (plan §9.2, C6-5). */
  'reservation.confirmed': ReservationMailParams;
  /** A booking's date, time, table or party changed (C6-6). */
  'reservation.changed': ReservationMailParams;
  /** A booking cancelled, by the guest or by Reception (C6-6). */
  'reservation.cancelled': ReservationMailParams;
  /** The reminder 24 hours before a booking (Q32, C6-8). */
  'reservation.reminder': ReservationMailParams;
  /** The website's contact form, to CNC's inbox (C6-7). */
  'enquiry.contact': ContactEnquiryMailParams;
  /** A large-party callback request, to CNC's inbox (C6-7). */
  'enquiry.group': GroupEnquiryMailParams;
  /**
   * A signed Paystack payment that did not match its checkout, to CNC's
   * inbox (plan §7.4 step 3, C7-2): no order was made, and a person must
   * look before the customer is refunded or served.
   */
  'checkout.needs-attention': CheckoutAttentionMailParams;
}

/** A held checkout as CNC's inbox reads it: display text only. */
export interface CheckoutAttentionMailParams {
  /** `cnc-order-<uuid>`, what Paystack's dashboard shows. */
  reference: string;
  /** The checkout's total, formatted: "₦26,500.00". */
  total: string;
  /** Why it was held, in words. */
  reason: string;
  /** The customer's name and phone, to call them. */
  name: string;
  phone: string;
}

/** A contact-form enquiry as CNC's inbox reads it. */
export interface ContactEnquiryMailParams {
  name: string;
  email: string;
  subject: string;
  message: string;
}

/** A large-party callback request as CNC's inbox reads it. */
export interface GroupEnquiryMailParams {
  name: string;
  /** As stored: `0` plus 10 digits. */
  phone: string;
  email: string | null;
  /** The room's customer title: "Dining", "Lounge". */
  venue: string;
  /** The date as the site writes it: "Sat 24 Oct 2026". */
  date: string;
  /** The form's text: "6 guests", "10+". */
  guests: string;
  /** "Anything we should know", or empty. */
  message: string;
}

/**
 * What a booking email says, all of it display text the queue can re-send
 * days later without reading the booking again.
 */
export interface ReservationMailParams {
  /** `RSV-000001`. */
  number: string;
  /** The guest's first name, for the greeting. */
  guestName: string;
  /** The room's customer title: "Dining", "Lounge". */
  venue: string;
  /** The table's name: "Booth 1". */
  table: string;
  /** The date as the site writes it: "Sat 24 Oct 2026". */
  date: string;
  /** The arrival time, `HH:mm`. */
  time: string;
  party: number;
  /** CNC's phone, from the business details, for calls inside 24 hours. */
  phone: string;
  /** The account page, where a signed-in guest changes the booking; null without a web URL. */
  accountUrl: string | null;
}

export type MailTemplateName = keyof MailTemplateParams;

interface MailTemplate<Name extends MailTemplateName> {
  isParams(value: unknown): value is MailTemplateParams[Name];
  render(params: MailTemplateParams[Name]): RenderedMail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The code, large and spaced, as TAY's sign-up code mail shows it. */
function codeBlock(code: string): string {
  return (
    '<p style="font-size:32px;letter-spacing:0.3em;font-weight:700;' +
    `margin:8px 0 20px 0;">${escapeHtml(code)}</p>`
  );
}

/** A code template's parameters: six digits and a whole number of minutes. */
function isCodeParams(
  value: unknown,
): value is { code: string; minutes: number } {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    /^\d{6}$/.test(value.code) &&
    typeof value.minutes === 'number' &&
    Number.isInteger(value.minutes) &&
    value.minutes > 0
  );
}

function isReservationParams(value: unknown): value is ReservationMailParams {
  return (
    isRecord(value) &&
    ['number', 'guestName', 'venue', 'table', 'date', 'time', 'phone'].every(
      (key) => typeof value[key] === 'string' && value[key] !== '',
    ) &&
    typeof value.party === 'number' &&
    Number.isInteger(value.party) &&
    value.party > 0 &&
    (value.accountUrl === null || typeof value.accountUrl === 'string')
  );
}

const nonEmptyStrings = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => typeof value[key] === 'string' && value[key] !== '');

function isContactEnquiryParams(
  value: unknown,
): value is ContactEnquiryMailParams {
  return (
    isRecord(value) &&
    nonEmptyStrings(value, ['name', 'email', 'subject', 'message'])
  );
}

function isGroupEnquiryParams(value: unknown): value is GroupEnquiryMailParams {
  return (
    isRecord(value) &&
    nonEmptyStrings(value, ['name', 'phone', 'venue', 'date', 'guests']) &&
    typeof value.message === 'string' &&
    (value.email === null ||
      (typeof value.email === 'string' && value.email !== ''))
  );
}

/** One line, for a subject: caller text may carry line breaks. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Labelled lines as an escaped HTML table, as the booking emails show them. */
function detailsHtml(rows: [string, string][]): string {
  return (
    '<table role="presentation" style="margin:8px 0 16px 0;">' +
    rows
      .map(
        ([label, value]) =>
          `<tr><td style="padding:2px 12px 2px 0;color:#6b6b6b;">` +
          `${escapeHtml(label)}</td><td style="padding:2px 0;">` +
          `<strong>${escapeHtml(value)}</strong></td></tr>`,
      )
      .join('') +
    '</table>'
  );
}

/**
 * Text the sender typed, escaped, with its line breaks kept: the only
 * formatting a plain message should carry (TAY's contact mail).
 */
const typedHtml = (text: string) =>
  `<p style="white-space:pre-wrap;">${escapeHtml(text)}</p>`;

const guestsText = (party: number) =>
  `${party} ${party === 1 ? 'guest' : 'guests'}`;

/** The booking's details, as lines of plain text. */
function bookingLines(p: ReservationMailParams, withParty: boolean): string[] {
  return [
    `Booking: ${p.number}`,
    `Space: ${p.venue}`,
    `Table: ${p.table}`,
    `Date: ${p.date}`,
    `Arrival: ${p.time}`,
    ...(withParty ? [`Party: ${guestsText(p.party)}`] : []),
  ];
}

/** The same details as an HTML list, every value escaped. */
function bookingHtml(p: ReservationMailParams, withParty: boolean): string {
  return detailsHtml(
    bookingLines(p, withParty).map((line) => {
      const [label, ...rest] = line.split(': ');

      return [label, rest.join(': ')];
    }),
  );
}

/** The 24-hour rule (Q6), with where to change the booking and whom to call. */
function changeRule(p: ReservationMailParams): { html: string; text: string } {
  const where =
    p.accountUrl === null
      ? 'in your CNC account'
      : `in your CNC account (${p.accountUrl})`;
  const text =
    `You can change or cancel this booking ${where} up to 24 hours ` +
    `before it starts. After that, please call CNC on ${p.phone}.`;
  const link =
    p.accountUrl === null
      ? 'in your CNC account'
      : `in <a href="${escapeHtml(p.accountUrl)}">your CNC account</a>`;

  return {
    html:
      `<p>You can change or cancel this booking ${link} up to 24 hours ` +
      `before it starts. After that, please call CNC on ` +
      `${escapeHtml(p.phone)}.</p>`,
    text,
  };
}

const TEMPLATES: { [Name in MailTemplateName]: MailTemplate<Name> } = {
  'reservation.reminder': {
    isParams: isReservationParams,
    render: (p) => {
      // The website's own reminder words ("See you soon", "Your table is
      // yours for your whole visit."), with the booking's date and time.
      const lead =
        `Your table in the ${p.venue} is booked for ${p.date} at ` +
        `${p.time}. Your table is yours for your whole visit.`;
      const call =
        'If you can no longer come, please call CNC on ' +
        `${p.phone}. Nothing is charged.`;

      return {
        subject: `See you soon at CNC: ${p.number}`,
        html: [
          `<p>Hello ${escapeHtml(p.guestName)},</p>`,
          `<p>${escapeHtml(lead)}</p>`,
          bookingHtml(p, true),
          `<p>${escapeHtml(call)}</p>`,
        ].join(''),
        text: [
          `Hello ${p.guestName},`,
          '',
          lead,
          '',
          ...bookingLines(p, true),
          '',
          call,
        ].join('\n'),
      };
    },
  },
  'enquiry.contact': {
    isParams: isContactEnquiryParams,
    render: (p) => {
      const rows: [string, string][] = [
        ['Name', p.name],
        ['Email', p.email],
        ['Subject', oneLine(p.subject)],
      ];

      return {
        subject: `CNC enquiry: ${oneLine(p.subject)}`,
        html: [
          '<p>A new enquiry came in through the CNC contact form.</p>',
          detailsHtml(rows),
          typedHtml(p.message),
          '<p>Reply to this email to answer the sender directly.</p>',
        ].join(''),
        text: [
          'A new enquiry came in through the CNC contact form.',
          '',
          ...rows.map(([label, value]) => `${label}: ${value}`),
          '',
          p.message,
          '',
          'Reply to this email to answer the sender directly.',
        ].join('\n'),
        replyTo: p.email,
      };
    },
  },
  'enquiry.group': {
    isParams: isGroupEnquiryParams,
    render: (p) => {
      const rows: [string, string][] = [
        ['Name', p.name],
        ['Phone', p.phone],
        ...(p.email === null
          ? []
          : ([['Email', p.email]] as [string, string][])),
        ['Space', p.venue],
        ['Date', p.date],
        ['Guests', oneLine(p.guests)],
      ];
      const close =
        p.email === null
          ? 'Call the guest back on the number above to arrange the tables.'
          : 'Call the guest back on the number above to arrange the ' +
            'tables, or reply to this email.';

      return {
        subject:
          `CNC large group: ${oneLine(p.guests)} in the ${p.venue} on ` +
          p.date,
        html: [
          '<p>A large party asked CNC to call them back about a booking.</p>',
          detailsHtml(rows),
          ...(p.message === '' ? [] : [typedHtml(p.message)]),
          `<p>${escapeHtml(close)}</p>`,
        ].join(''),
        text: [
          'A large party asked CNC to call them back about a booking.',
          '',
          ...rows.map(([label, value]) => `${label}: ${value}`),
          ...(p.message === '' ? [] : ['', p.message]),
          '',
          close,
        ].join('\n'),
        ...(p.email === null ? {} : { replyTo: p.email }),
      };
    },
  },
  'reservation.confirmed': {
    isParams: isReservationParams,
    render: (p) => {
      const rule = changeRule(p);

      return {
        subject: `Your table at CNC is booked: ${p.number}`,
        html: [
          `<p>Hello ${escapeHtml(p.guestName)},</p>`,
          '<p>Your table is reserved. Your table is yours for your whole ' +
            'visit.</p>',
          bookingHtml(p, true),
          rule.html,
        ].join(''),
        text: [
          `Hello ${p.guestName},`,
          '',
          'Your table is reserved. Your table is yours for your whole visit.',
          '',
          ...bookingLines(p, true),
          '',
          rule.text,
        ].join('\n'),
      };
    },
  },
  'reservation.changed': {
    isParams: isReservationParams,
    render: (p) => {
      const rule = changeRule(p);

      return {
        subject: `Your CNC booking ${p.number} has changed`,
        html: [
          `<p>Hello ${escapeHtml(p.guestName)},</p>`,
          '<p>Your reservation has been changed. These are the new ' +
            'details:</p>',
          bookingHtml(p, true),
          rule.html,
        ].join(''),
        text: [
          `Hello ${p.guestName},`,
          '',
          'Your reservation has been changed. These are the new details:',
          '',
          ...bookingLines(p, true),
          '',
          rule.text,
        ].join('\n'),
      };
    },
  },
  'reservation.cancelled': {
    isParams: isReservationParams,
    render: (p) => ({
      subject: `Your CNC booking ${p.number} is cancelled`,
      html: [
        `<p>Hello ${escapeHtml(p.guestName)},</p>`,
        '<p>Your reservation has been cancelled. The table is free for ' +
          'other guests. Nothing is charged.</p>',
        bookingHtml(p, false),
        `<p>If this is a mistake, please call CNC on ${escapeHtml(p.phone)}.</p>`,
      ].join(''),
      text: [
        `Hello ${p.guestName},`,
        '',
        'Your reservation has been cancelled. The table is free for other ' +
          'guests. Nothing is charged.',
        '',
        ...bookingLines(p, false),
        '',
        `If this is a mistake, please call CNC on ${p.phone}.`,
      ].join('\n'),
    }),
  },
  'checkout.needs-attention': {
    isParams: (value): value is CheckoutAttentionMailParams =>
      isRecord(value) &&
      nonEmptyStrings(value, ['reference', 'total', 'reason', 'name']) &&
      typeof value.phone === 'string',
    render: (p) => {
      const rows: [string, string][] = [
        ['Reference', p.reference],
        ['Checkout total', p.total],
        ['Why', p.reason],
        ['Customer', p.name],
        ['Phone', p.phone],
      ];

      return {
        subject: `Online payment needs attention: ${p.reference}`,
        html: [
          '<p>A Paystack payment arrived that does not match its online ' +
            'checkout, so no order was made. Check the payment in the ' +
            'Paystack dashboard and call the customer before anything is ' +
            'cooked or refunded.</p>',
          detailsHtml(rows),
        ].join(''),
        text: [
          'A Paystack payment arrived that does not match its online ' +
            'checkout, so no order was made. Check the payment in the ' +
            'Paystack dashboard and call the customer before anything is ' +
            'cooked or refunded.',
          '',
          ...rows.map(([label, value]) => `${label}: ${value}`),
        ].join('\n'),
      };
    },
  },
  'customer.email-change-code': {
    isParams: isCodeParams,
    render: ({ code, minutes }) => ({
      subject: `${code} is your code to change your CNC email`,
      html: [
        '<p>Hello,</p>',
        '<p>Type this code in your CNC account to make this your sign-in ' +
          'email:</p>',
        codeBlock(code),
        `<p>It stops working in ${minutes} minutes.</p>`,
        '<p>If you did not ask to change the email on a CNC account, you ' +
          'can ignore this email. Nothing changes without the code.</p>',
      ].join(''),
      text: [
        'Hello,',
        '',
        'Type this code in your CNC account to make this your sign-in email:',
        '',
        `    ${code}`,
        '',
        `It stops working in ${minutes} minutes.`,
        '',
        'If you did not ask to change the email on a CNC account, you can ' +
          'ignore this email. Nothing changes without the code.',
      ].join('\n'),
    }),
  },
  'customer.email-changed': {
    isParams: (value): value is MailTemplateParams['customer.email-changed'] =>
      isRecord(value) &&
      typeof value.newEmailMasked === 'string' &&
      value.newEmailMasked.length > 0,
    render: ({ newEmailMasked }) => ({
      subject: 'Your CNC sign-in email has changed',
      html: [
        '<p>Hello,</p>',
        '<p>The sign-in email on your CNC account is now ' +
          `<strong>${escapeHtml(newEmailMasked)}</strong>. This address ` +
          'will no longer sign you in.</p>',
        '<p>If you did not make this change, contact CNC straight away.</p>',
      ].join(''),
      text: [
        'Hello,',
        '',
        `The sign-in email on your CNC account is now ${newEmailMasked}. ` +
          'This address will no longer sign you in.',
        '',
        'If you did not make this change, contact CNC straight away.',
      ].join('\n'),
    }),
  },
  'customer.sign-in-code': {
    isParams: isCodeParams,
    render: ({ code, minutes }) => ({
      subject: `${code} is your CNC sign-in code`,
      html: [
        '<p>Hello,</p>',
        '<p>Type this code on the CNC sign-in page to continue:</p>',
        codeBlock(code),
        `<p>It stops working in ${minutes} minutes.</p>`,
        '<p>If you did not ask to sign in to CNC, you can ignore this ' +
          'email. Nobody can sign in without the code.</p>',
      ].join(''),
      text: [
        'Hello,',
        '',
        'Type this code on the CNC sign-in page to continue:',
        '',
        `    ${code}`,
        '',
        `It stops working in ${minutes} minutes.`,
        '',
        'If you did not ask to sign in to CNC, you can ignore this email. ' +
          'Nobody can sign in without the code.',
      ].join('\n'),
    }),
  },
};

export function isMailTemplateName(name: string): name is MailTemplateName {
  return Object.keys(TEMPLATES).includes(name);
}

/**
 * Render a stored message. Throws when the name is unknown or the
 * parameters do not have the template's shape: a message that cannot be
 * rendered is given up, never sent half-filled.
 */
export function renderMail(name: string, params: unknown): RenderedMail {
  if (!isMailTemplateName(name)) {
    throw new Error(`Unknown mail template ${JSON.stringify(name)}.`);
  }

  return renderKnown(name, params);
}

function renderKnown<Name extends MailTemplateName>(
  name: Name,
  params: unknown,
): RenderedMail {
  const template = TEMPLATES[name] as MailTemplate<Name>;

  if (!template.isParams(params)) {
    throw new Error(`The parameters of mail template ${name} are malformed.`);
  }

  return template.render(params);
}
