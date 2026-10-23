import { escapeHtml } from './escape-html';

/**
 * The frame every CNC email is sent inside: the banner, the body, the
 * footer (plan §9.2, §11: "a new `cnc-mail-frame.ts`").
 *
 * TAY's frame (`tay-mail-frame.ts`) is copied as the structure only: nested
 * tables with every style inline, because email clients are not browsers
 * (Outlook renders through Word, Gmail strips `<style>` blocks in some
 * views). The colours, the wordmark and the footer are CNC's.
 *
 * ## The body is trusted; the frame escapes only what it adds
 *
 * `html` arrives already escaped by its template, because every template
 * runs caller-supplied text through `escapeHtml`. The frame must not escape
 * it again (it would double-encode every `&amp;`). The one value the frame
 * interpolates itself, the logo URL, comes from configuration, and is
 * escaped anyway because it lands inside an attribute.
 *
 * ## The logo needs a URL, not a file
 *
 * An image in an email is a link the recipient's client fetches, so it must
 * live on a host that serves it. The CNC site serves its app icon at
 * `/icons/icon-192.png` under its `/cnc` base, built through
 * `CncConfigService.buildWebUrl`. With no web URL the banner shows the
 * wordmark alone: a mail with a broken picture in its header looks like
 * phishing.
 */

/** The brand, as `cnc-frontend/app/globals.css` defines it. */
const IVORY = '#f6f2eb';
const KHAKI = '#caba9c';
const UMBER = '#8a6240';
const NOIR = '#4d2d18';
const INK = '#241b16';
const MUTED = '#6f6259';
const RULE = '#e7dfd2';

export interface CncMailFrameOptions {
  /** The escaped body, as the template composed it. */
  html: string;
  /** Absolute URL of the logo, or undefined to show the wordmark alone. */
  logoUrl: string | undefined;
}

export function frameCncMail({ html, logoUrl }: CncMailFrameOptions): string {
  const mark =
    logoUrl === undefined
      ? ''
      : `<img src="${escapeHtml(logoUrl)}" width="36" height="36" alt="" ` +
        'style="display:block;width:36px;height:36px;border:0;border-radius:4px;">';

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    '<title>Chef Noro Culinary</title>',
    '</head>',
    `<body style="margin:0;padding:0;background:${IVORY};` +
      'font-family:Arial,Helvetica,sans-serif;">',
    // The outer table centres the card and gives it a ground on clients that
    // ignore the body background.
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      `border="0" style="background:${IVORY};">`,
    '<tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" ' +
      'border="0" style="max-width:600px;width:100%;background:#ffffff;' +
      'border-collapse:separate;border-radius:8px;overflow:hidden;">',

    // The banner: a khaki rule, then the mark and the wordmark on noir.
    `<tr><td style="background:${KHAKI};height:5px;font-size:0;line-height:0;">&nbsp;</td></tr>`,
    `<tr><td style="background:${NOIR};padding:18px 28px;">`,
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>',
    mark === ''
      ? ''
      : `<td style="padding-right:12px;vertical-align:middle;">${mark}</td>`,
    "<td style=\"vertical-align:middle;font-family:Georgia,'Times New Roman',serif;" +
      `font-size:17px;letter-spacing:0.12em;color:${IVORY};">` +
      'CHEF NORO CULINARY</td>',
    '</tr></table>',
    '</td></tr>',

    // The body. Paragraph styling is in a <style> block and repeated inline
    // on the cell, so a client that strips the block still reads well.
    '<tr><td style="padding:28px 28px 8px 28px;font-family:Arial,Helvetica,sans-serif;' +
      `font-size:16px;line-height:1.55;color:${INK};">`,
    '<style>',
    `.cnc-body p{margin:0 0 16px 0;font-size:16px;line-height:1.55;color:${INK};}`,
    `.cnc-body a{color:${UMBER};font-weight:700;}`,
    `.cnc-body strong{color:${NOIR};}`,
    '</style>',
    `<div class="cnc-body">${html}</div>`,
    '</td></tr>',

    // The footer.
    `<tr><td style="padding:16px 28px 24px 28px;border-top:1px solid ${RULE};` +
      'font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;' +
      `color:${MUTED};">`,
    'Chef Noro Culinary &middot; Restaurant and lounge, Jos.<br>',
    'This is a transactional email about your CNC account, order or booking.',
    '</td></tr>',

    '</table>',
    '</td></tr>',
    '</table>',
    '</body>',
    '</html>',
  ].join('');
}
