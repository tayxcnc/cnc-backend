import sharp from 'sharp';

/**
 * Real image bytes for the upload suites, made with `sharp`, so the routes
 * see exactly what a phone would send: a JPEG, PNG or WebP of a given size.
 */
export function testImage(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' = 'jpeg',
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: '#aa5522' },
  })
    .toFormat(format)
    .toBuffer();
}
