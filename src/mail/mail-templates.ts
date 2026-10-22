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
  const rows = bookingLines(p, withParty).map((line) => {
    const [label, ...rest] = line.split(': ');

    return (
      `<tr><td style="padding:2px 12px 2px 0;color:#6b6b6b;">` +
      `${escapeHtml(label)}</td><td style="padding:2px 0;">` +
      `<strong>${escapeHtml(rest.join(': '))}</strong></td></tr>`
    );
  });

  return `<table role="presentation" style="margin:8px 0 16px 0;">${rows.join('')}</table>`;
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
