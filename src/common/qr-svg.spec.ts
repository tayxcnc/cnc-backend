import { renderQrSvg } from './qr-svg';

/**
 * The QR renderer (copied with TAY's spec). The library is trusted to make a
 * valid symbol; what is pinned here is that the options chosen are applied,
 * because a library default changing underneath would only show up as a
 * code that stopped scanning at the reception desk.
 */
describe('renderQrSvg', () => {
  const PAYLOAD = 'CNC-ID:CNC-S001:AAAA-BBBB_CCCC-DDDD';

  it('produces an SVG document', async () => {
    const svg = await renderQrSvg(PAYLOAD);

    expect(svg).toContain('<svg');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });

  it('does not contain the payload as readable text', async () => {
    const svg = await renderQrSvg(PAYLOAD);

    expect(svg).not.toContain(PAYLOAD);
    expect(svg).not.toContain('AAAA-BBBB_CCCC-DDDD');
  });

  it('renders black on white', async () => {
    const svg = await renderQrSvg(PAYLOAD);

    expect(svg).toContain('#ffffff');
    expect(svg).toContain('#000000');
  });

  it('includes the four-module quiet zone in the viewBox', async () => {
    const svg = await renderQrSvg(PAYLOAD);
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);

    expect(viewBox).not.toBeNull();

    const [, width, height] = viewBox!;

    expect(width).toBe(height);
    // A version-1 symbol is 21 modules; a four-module margin on each side
    // makes the box at least 29.
    expect(Number(width)).toBeGreaterThanOrEqual(29);
  });

  it('renders different payloads differently, and one payload identically', async () => {
    const [first, again, other] = await Promise.all([
      renderQrSvg(PAYLOAD),
      renderQrSvg(PAYLOAD),
      renderQrSvg('CNC-ID:CNC-S002:EEEE-FFFF_GGGG-HHHH'),
    ]);

    expect(first).toBe(again);
    expect(first).not.toBe(other);
  });

  it('renders a full-length staff payload', async () => {
    // A real token is 43 base64url characters.
    const svg = await renderQrSvg(`CNC-ID:CNC-S123:${'a'.repeat(43)}`);

    expect(svg).toContain('<svg');
  });
});
