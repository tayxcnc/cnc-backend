import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import sharp from 'sharp';
import {
  inspectImage,
  JPEG,
  MAX_IMAGE_BYTES,
  PHOTO_MISSING_MESSAGE,
  PHOTO_TOO_LARGE_MESSAGE,
  PHOTO_UNSUPPORTED_MESSAGE,
  PNG,
  readUploadedImage,
  WEBP,
} from './uploaded-image';

function blank(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 120, b: 40 },
    },
  });
}

describe('inspectImage', () => {
  it('reads a JPEG, a PNG and a WebP by their bytes, with their sizes', async () => {
    const jpeg = await blank(30, 20).jpeg().toBuffer();
    const png = await blank(31, 21).png().toBuffer();
    const webp = await blank(32, 22).webp().toBuffer();
    const lossless = await blank(33, 23).webp({ lossless: true }).toBuffer();

    expect(inspectImage(jpeg)).toEqual({
      ok: true,
      image: { format: JPEG, width: 30, height: 20 },
    });
    expect(inspectImage(png)).toEqual({
      ok: true,
      image: { format: PNG, width: 31, height: 21 },
    });
    expect(inspectImage(webp)).toEqual({
      ok: true,
      image: { format: WEBP, width: 32, height: 22 },
    });
    expect(inspectImage(lossless)).toEqual({
      ok: true,
      image: { format: WEBP, width: 33, height: 23 },
    });
  });

  it('refuses text, whatever it would be called', () => {
    expect(inspectImage(Buffer.from('not an image at all'))).toEqual({
      ok: false,
      rejection: { reason: 'unsupported' },
    });
  });

  it('refuses a PNG header claiming more pixels than can be decoded', () => {
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
    header.writeUInt32BE(30000, 16);
    header.writeUInt32BE(30000, 20);

    expect(inspectImage(header)).toEqual({
      ok: false,
      rejection: { reason: 'too-many-pixels', width: 30000, height: 30000 },
    });
  });
});

describe('readUploadedImage', () => {
  it('passes a real photo through with its inspection', async () => {
    const bytes = await blank(40, 40).png().toBuffer();

    expect(readUploadedImage({ buffer: bytes })).toEqual({
      bytes,
      image: { format: PNG, width: 40, height: 40 },
    });
  });

  it('answers no file and an empty file with 400', () => {
    for (const file of [undefined, { buffer: Buffer.alloc(0) }]) {
      expect(() => readUploadedImage(file)).toThrow(
        new BadRequestException(PHOTO_MISSING_MESSAGE),
      );
    }
  });

  it('answers a file over 5MB with 413', () => {
    expect(() =>
      readUploadedImage({ buffer: Buffer.alloc(MAX_IMAGE_BYTES + 1) }),
    ).toThrow(new PayloadTooLargeException(PHOTO_TOO_LARGE_MESSAGE));
  });

  it('answers bytes that are not an image with 415', () => {
    expect(() =>
      readUploadedImage({ buffer: Buffer.from('%PDF-1.7 renamed.jpg') }),
    ).toThrow(new UnsupportedMediaTypeException(PHOTO_UNSUPPORTED_MESSAGE));
  });
});
