import { StreamableFile, applyDecorators } from '@nestjs/common';
import { ApiProduces, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import type { StoredPhoto } from './photo-store.service';
import { JPEG, PNG, WEBP } from './uploaded-image';

/**
 * How long the signed-in browser may keep a streamed photo: five minutes,
 * TAY's figure for its photo routes. Long enough that a screen drawing the
 * same face into a card, then a PDF, then a reprint asks the API once;
 * short enough that a replaced photo shows within minutes even where the
 * screen does not ask again by itself.
 */
export const PHOTO_MAX_AGE_SECONDS = 300;

/**
 * `private`: only the browser that asked may keep it, never a proxy or a
 * shared cache, because a staff photo is a face behind a sign-in.
 */
export const PHOTO_CACHE_CONTROL = `private, max-age=${PHOTO_MAX_AGE_SECONDS}`;

/**
 * A stored photo as the response body (CS B5), with its stored type and
 * length, for `GET /staff/me/photo` and `GET /staff/people/:id/photo`.
 *
 * Headers are set here, after the photo was read, so a refusal or a 404
 * never carries the photo's caching:
 * - `Cache-Control` as above;
 * - `Vary: Authorization`, appended to the `Vary: Origin` CORS already set
 *   (never replacing it). The venue's tablets are shared, and
 *   `/staff/me/photo` is one URL for every person: without it, the next
 *   person signing in on the same tablet within five minutes could be
 *   shown the previous person's face from the browser's cache.
 *
 * The bytes are the ones stored at upload, already cropped to the staff
 * square (320 pixels) with metadata removed, so nothing is resized here.
 */
export function photoFile(
  response: Response,
  photo: StoredPhoto,
): StreamableFile {
  response.setHeader('Cache-Control', PHOTO_CACHE_CONTROL);
  response.vary('Authorization');

  return new StreamableFile(photo.body, {
    type: photo.contentType,
    length: photo.body.length,
  });
}

/** The Swagger answer for a streamed photo: the image itself. */
export function ApiPhotoResponse(): MethodDecorator {
  return applyDecorators(
    ApiProduces(JPEG.contentType, PNG.contentType, WEBP.contentType),
    ApiResponse({
      status: 200,
      description:
        'The photo as stored at upload (a square of at most 320 pixels), ' +
        'with its own content type. Cached by the browser only ' +
        `(${PHOTO_CACHE_CONTROL}), and varied by Authorization.`,
      schema: { type: 'string', format: 'binary' },
    }),
  );
}
