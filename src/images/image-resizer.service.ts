import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import {
  type ImageFormat,
  type InspectedImage,
  MAX_IMAGE_PIXELS,
  PNG,
  WEBP,
} from './uploaded-image';

/**
 * How each kind of photo is stored (A17): a staff photo is a square of at
 * most 320 pixels (the staff card and avatars), a menu photo fits inside
 * 800 pixels at its own shape (the menu pages frame it). Customer photos
 * (256 square) arrive with C6.
 */
export const PHOTO_SHAPES = {
  staff: { edge: 320, square: true },
  menu: { edge: 800, square: false },
} as const;

export type PhotoKind = keyof typeof PHOTO_SHAPES;

/**
 * Quality for the two lossy formats: past 82, more bytes stop buying
 * visible quality at these sizes. PNG is lossless and compressed instead.
 */
const LOSSY_QUALITY = 82;

/**
 * Bringing an upload down to the photo that is stored: TAY's
 * `PhotoResizerService`, copied, with CNC's two shapes.
 *
 * - **Orientation is applied, then every piece of metadata is dropped.**
 *   `.rotate()` reads the EXIF orientation and turns the pixels, and
 *   `sharp` writes no metadata unless asked, so the stored file carries no
 *   EXIF at all: no camera serial, no timestamp, and no GPS position, which
 *   on a phone photograph is very often somebody's home.
 * - **Never enlarged.** A small photo stays its own size; upscaling makes a
 *   blurred image that is bigger in bytes.
 * - **The format is kept.** A PNG stays a PNG, so a transparent background
 *   does not turn black as it would in a JPEG.
 * - **Decoding is bounded** by the same pixel limit `inspectImage` checks in
 *   the header, so the two halves of the bomb guard agree on one number.
 */
@Injectable()
export class ImageResizerService {
  /** Resize and re-encode an inspected upload for `kind`. */
  resize(
    kind: PhotoKind,
    bytes: Buffer,
    image: InspectedImage,
  ): Promise<Buffer> {
    const shape = PHOTO_SHAPES[kind];
    const decoder = sharp(bytes, {
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).rotate();

    if (shape.square) {
      // A centre-cropped square, never larger than the source's shorter
      // side. `min` over both dimensions is unaffected by a quarter turn.
      const edge = Math.min(shape.edge, image.width, image.height);

      return this.encode(
        decoder.resize(edge, edge, { fit: 'cover', position: 'centre' }),
        image.format,
      );
    }

    return this.encode(
      decoder.resize(shape.edge, shape.edge, {
        fit: 'inside',
        withoutEnlargement: true,
      }),
      image.format,
    );
  }

  private encode(pipeline: sharp.Sharp, format: ImageFormat): Promise<Buffer> {
    switch (format.contentType) {
      case PNG.contentType:
        return pipeline.png({ compressionLevel: 9 }).toBuffer();
      case WEBP.contentType:
        return pipeline.webp({ quality: LOSSY_QUALITY }).toBuffer();
      default:
        // Progressive, so a photo on a slow connection appears at once at low
        // detail rather than filling in from the top.
        return pipeline
          .jpeg({ quality: LOSSY_QUALITY, progressive: true })
          .toBuffer();
    }
  }
}
