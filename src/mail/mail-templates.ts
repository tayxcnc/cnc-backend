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

const TEMPLATES: { [Name in MailTemplateName]: MailTemplate<Name> } = {
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
