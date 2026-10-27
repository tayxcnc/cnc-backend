import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';

/**
 * Deciding what an uploaded file is, by its bytes (A17): TAY's
 * `profile-photo.ts` and `uploaded-image.ts`, copied into one file.
 *
 * ## The filename and the content type are the client's opinion
 *
 * A browser sends `Content-Type` from the operating system's guess, and the
 * filename is whatever the uploader typed. Neither is evidence: a document
 * renamed to `photo.jpg` and announced as `image/jpeg` passes every check
 * made of those two fields. Every accepted format begins with a fixed
 * signature, and reading it is the whole decision.
 *
 * ## Dimensions, read from the same header
 *
 * The five-megabyte cap bounds the transfer, not the picture: a JPEG of
 * 12,000 × 12,000 pixels fits inside it. The width and height are parsed
 * from the header, for the resizer and for a **decompression bomb guard**: a
 * file claiming more pixels than can safely be decoded is refused before any
 * decoder is handed it, because a bomb's cost is paid at decode time.
 */

/** Largest upload accepted, in bytes: five megabytes (A17, D54). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Most pixels a file may claim before it is refused unread: 16,383², which
 * is `sharp`'s own default `limitInputPixels`, passed back to it explicitly
 * by `ImageResizerService`, so the header check and the decoder agree on one
 * number. Not a size policy: a 48-megapixel phone photo passes and is
 * resized.
 */
export const MAX_IMAGE_PIXELS = 16383 * 16383;

/**
 * The part of a multipart file the upload path reads: the bytes. The name
 * and the declared type are deliberately never consulted. Declared here
 * rather than typed as `Express.Multer.File`, which would need
 * `@types/multer` for one field.
 */
export interface UploadedImageFile {
  buffer: Buffer;
}

/** An image format this service accepts and stores. */
export interface ImageFormat {
  /** What the object is stored as, and what a signed URL serves it as. */
  contentType: string;
  /** File extension, without the dot. */
  extension: string;
}

export const JPEG: ImageFormat = {
  contentType: 'image/jpeg',
  extension: 'jpg',
};
export const PNG: ImageFormat = { contentType: 'image/png', extension: 'png' };
export const WEBP: ImageFormat = {
  contentType: 'image/webp',
  extension: 'webp',
};

/** What a valid upload turned out to be. */
export interface InspectedImage {
  format: ImageFormat;
  width: number;
  height: number;
}

/** Why an upload is not an image this service can read. */
export type ImageRejection =
  | { reason: 'unsupported' }
  | { reason: 'truncated' }
  | { reason: 'too-many-pixels'; width: number; height: number };

export type ImageInspection =
  | { ok: true; image: InspectedImage }
  | { ok: false; rejection: ImageRejection };

function startsWith(bytes: Buffer, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;

  return signature.every((byte, index) => bytes[index] === byte);
}

/** PNG: the IHDR chunk's width and height, big-endian, at 16 and 20. */
function inspectPng(bytes: Buffer): ImageInspection {
  if (bytes.length < 24) {
    return { ok: false, rejection: { reason: 'truncated' } };
  }

  return {
    ok: true,
    image: {
      format: PNG,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    },
  };
}

/**
 * JPEG: walk the marker segments to the start-of-frame. `SOFn` markers are
 * `0xC0`–`0xCF` except `0xC4`, `0xC8` and `0xCC`, which sit in the range and
 * are not frame headers. Height comes before width.
 */
function inspectJpeg(bytes: Buffer): ImageInspection {
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return { ok: false, rejection: { reason: 'truncated' } };
    }

    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);

    const isFrameHeader =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isFrameHeader) {
      return {
        ok: true,
        image: {
          format: JPEG,
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        },
      };
    }

    if (length < 2) {
      return { ok: false, rejection: { reason: 'truncated' } };
    }

    offset += 2 + length;
  }

  return { ok: false, rejection: { reason: 'truncated' } };
}

/**
 * WebP: `RIFF`, a size, `WEBP`, then a chunk saying how the dimensions are
 * encoded. All three encodings are read (`VP8 ` lossy, `VP8L` lossless,
 * `VP8X` extended), or ordinary files from ordinary tools are refused.
 */
function inspectWebp(bytes: Buffer): ImageInspection {
  const chunk = bytes.length >= 16 ? bytes.toString('ascii', 12, 16) : '';

  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return {
      ok: true,
      image: {
        format: WEBP,
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      },
    };
  }

  if (chunk === 'VP8L' && bytes.length >= 25) {
    const packed = bytes.readUInt32LE(21);

    return {
      ok: true,
      image: {
        format: WEBP,
        width: (packed & 0x3fff) + 1,
        height: ((packed >> 14) & 0x3fff) + 1,
      },
    };
  }

  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      ok: true,
      image: {
        format: WEBP,
        width: bytes.readUIntLE(24, 3) + 1,
        height: bytes.readUIntLE(27, 3) + 1,
      },
    };
  }

  return { ok: false, rejection: { reason: 'truncated' } };
}

/**
 * What this file is, judged by its bytes alone: nothing about its name or
 * declared type reaches this function.
 */
export function inspectImage(bytes: Buffer): ImageInspection {
  const isWebp =
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP';

  let inspection: ImageInspection;

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    inspection = inspectJpeg(bytes);
  } else if (
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    inspection = inspectPng(bytes);
  } else if (isWebp) {
    inspection = inspectWebp(bytes);
  } else {
    return { ok: false, rejection: { reason: 'unsupported' } };
  }

  if (!inspection.ok) return inspection;

  const { width, height } = inspection.image;

  if (width === 0 || height === 0) {
    return { ok: false, rejection: { reason: 'truncated' } };
  }

  if (width * height > MAX_IMAGE_PIXELS) {
    return {
      ok: false,
      rejection: { reason: 'too-many-pixels', width, height },
    };
  }

  return inspection;
}

/** The multipart field every photo upload uses. */
export const PHOTO_FIELD = 'photo';

/** No file, or an empty one (400). */
export const PHOTO_MISSING_MESSAGE =
  'Send the photo as multipart/form-data in a field named `photo`.';

/** Over the size cap (413). */
export const PHOTO_TOO_LARGE_MESSAGE = `A photo must be ${MAX_IMAGE_BYTES / (1024 * 1024)}MB or smaller.`;

/** Not a JPEG, PNG or WebP by its bytes (415). */
export const PHOTO_UNSUPPORTED_MESSAGE =
  'A photo must be a JPEG, PNG or WebP image. The file is judged by its ' +
  'content and not by its name, so renaming it will not help.';

/**
 * Accept an uploaded photo or refuse it, judged by its bytes (TAY's
 * `readUploadedImage`):
 *
 * - no file, or an empty one: 400;
 * - over five megabytes: 413 (the interceptor's own limit stops the body
 *   being read; this turns a file that reached here anyway into a sentence);
 * - a header claiming too many pixels to decode safely: 400, naming the
 *   claimed size, before any decoder sees the file;
 * - bytes that are not JPEG, PNG or WebP: 415, whatever the name says.
 */
export function readUploadedImage(file: UploadedImageFile | undefined): {
  bytes: Buffer;
  image: InspectedImage;
} {
  if (file === undefined || file.buffer.length === 0) {
    throw new BadRequestException(PHOTO_MISSING_MESSAGE);
  }

  if (file.buffer.length > MAX_IMAGE_BYTES) {
    throw new PayloadTooLargeException(PHOTO_TOO_LARGE_MESSAGE);
  }

  const inspection = inspectImage(file.buffer);

  if (!inspection.ok) {
    const { rejection } = inspection;

    if (rejection.reason === 'too-many-pixels') {
      throw new BadRequestException(
        `That file claims to be ${rejection.width}×${rejection.height} ` +
          'pixels, which is too large to decode. A photograph from a phone ' +
          'or a camera is nowhere near this size.',
      );
    }

    // "Not an image" and "a truncated image" get one answer: telling them
    // apart helps somebody probing the parser more than anyone with a real
    // photo.
    throw new UnsupportedMediaTypeException(PHOTO_UNSUPPORTED_MESSAGE);
  }

  return { bytes: file.buffer, image: inspection.image };
}
