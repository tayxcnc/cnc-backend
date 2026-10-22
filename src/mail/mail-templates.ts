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

const TEMPLATES: { [Name in MailTemplateName]: MailTemplate<Name> } = {
  'customer.sign-in-code': {
    isParams: (value): value is MailTemplateParams['customer.sign-in-code'] =>
      isRecord(value) &&
      typeof value.code === 'string' &&
      /^\d{6}$/.test(value.code) &&
      typeof value.minutes === 'number' &&
      Number.isInteger(value.minutes) &&
      value.minutes > 0,
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
