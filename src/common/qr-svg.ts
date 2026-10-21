import { toString as qrToString } from 'qrcode';

/**
 * How a staff ID's QR code is rendered. Copied from TAY's `renderQrSvg`
 * (plan §11, "QR"), with its settings and their reasons:
 *
 * - **Error correction M.** About 15% of a damaged symbol is recovered:
 *   enough for a scuffed screen or a fingerprint, without packing so many
 *   modules into the code that a small screen shrinks it below a scanner's
 *   resolution.
 * - **A four-module margin**, the quiet zone the QR specification requires.
 *   A code rendered flush to its edge fails against a busy background, and
 *   only intermittently.
 * - **Black on white, no logo.** A scanner reads contrast. The colours are
 *   stated rather than left to the library's defaults, so a new version of
 *   the library cannot change what the scanner sees.
 */
const QR_OPTIONS = {
  type: 'svg',
  errorCorrectionLevel: 'M',
  margin: 4,
  color: { dark: '#000000ff', light: '#ffffffff' },
} as const;

/**
 * Render a QR payload as an SVG document.
 *
 * Rendered on the server so the credential inside never travels as text: a
 * token in a JSON body ends up in a log, a browser cache or a screenshot of
 * the network panel, while a rendered image is readable only by a camera
 * pointed at it. The payload never appears in the markup.
 */
export function renderQrSvg(payload: string): Promise<string> {
  return qrToString(payload, QR_OPTIONS);
}
