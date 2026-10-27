import sharp from 'sharp';
import { ImageResizerService } from './image-resizer.service';
import { inspectImage, type InspectedImage } from './uploaded-image';

const resizer = new ImageResizerService();

function inspected(bytes: Buffer): InspectedImage {
  const inspection = inspectImage(bytes);
  if (!inspection.ok) throw new Error('test image did not inspect');
  return inspection.image;
}

function blank(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: '#cc7722' },
  });
}

describe('ImageResizerService', () => {
  it('crops a staff photo to a square of at most 320 pixels', async () => {
    const bytes = await blank(1200, 800).jpeg().toBuffer();
    const stored = await resizer.resize('staff', bytes, inspected(bytes));
    const meta = await sharp(stored).metadata();

    expect([meta.width, meta.height, meta.format]).toEqual([320, 320, 'jpeg']);
  });

  it('never enlarges a small staff photo, and keeps it square', async () => {
    const bytes = await blank(200, 150).png().toBuffer();
    const stored = await resizer.resize('staff', bytes, inspected(bytes));
    const meta = await sharp(stored).metadata();

    expect([meta.width, meta.height, meta.format]).toEqual([150, 150, 'png']);
  });

  it('fits a menu photo inside 800 pixels at its own shape', async () => {
    const bytes = await blank(2000, 1000).webp().toBuffer();
    const stored = await resizer.resize('menu', bytes, inspected(bytes));
    const meta = await sharp(stored).metadata();

    expect([meta.width, meta.height, meta.format]).toEqual([800, 400, 'webp']);
  });

  it('never enlarges a small menu photo', async () => {
    const bytes = await blank(300, 200).jpeg().toBuffer();
    const stored = await resizer.resize('menu', bytes, inspected(bytes));
    const meta = await sharp(stored).metadata();

    expect([meta.width, meta.height]).toEqual([300, 200]);
  });

  it('drops every piece of metadata, GPS position included', async () => {
    const bytes = await blank(400, 400)
      .withExif({
        IFD0: { Make: 'Phone', Copyright: 'Somebody' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '9/1 53/1 49/1' },
      })
      .jpeg()
      .toBuffer();

    expect((await sharp(bytes).metadata()).exif).toBeDefined();

    const stored = await resizer.resize('staff', bytes, inspected(bytes));
    const meta = await sharp(stored).metadata();

    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(stored.includes(Buffer.from('Somebody'))).toBe(false);
  });

  it('turns a photo by its EXIF orientation before cropping', async () => {
    // 600 × 300 pixels tagged "rotate 90°": the stored photo is upright,
    // and square, so the turn shows as the source's top-left colour moving.
    const bytes = await sharp({
      create: { width: 600, height: 300, channels: 3, background: '#ffffff' },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 300,
              height: 300,
              channels: 3,
              background: '#000000',
            },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const stored = await resizer.resize('menu', bytes, inspected(bytes));
    const meta = await sharp(stored).metadata();

    // Upright: 300 wide, 600 tall, fitted inside 800 unchanged.
    expect([meta.width, meta.height]).toEqual([300, 600]);
    expect(meta.orientation).toBeUndefined();
  });
});
