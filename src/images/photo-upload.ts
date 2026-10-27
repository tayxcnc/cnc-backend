import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  PayloadTooLargeException,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import type { Observable } from 'rxjs';
import { VersionedWriteDto } from '../common/dto/versioned-write.dto';
import {
  MAX_IMAGE_BYTES,
  PHOTO_FIELD,
  PHOTO_TOO_LARGE_MESSAGE,
} from './uploaded-image';

/**
 * Multer, holding the file in memory (no `dest`): it is at most five
 * megabytes and goes straight on to Cloud Storage, and a temporary file on
 * Cloud Run's throwaway disk would be one more thing to clean up.
 * `fileSize` stops the body being read past the cap, so a caller sending a
 * gigabyte is cut off rather than buffered.
 */
const MulterPhoto = FileInterceptor(PHOTO_FIELD, {
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 4 },
});

/**
 * The multipart upload of one photo, in the field `photo`.
 *
 * Multer's own 413 says "File too large"; this answers with the sentence
 * every other photo refusal uses, so the screen shows one wording whichever
 * check caught the file. Only multer's refusal is rewritten: errors from the
 * handler pass through the returned stream untouched.
 */
@Injectable()
export class PhotoUploadInterceptor implements NestInterceptor {
  private readonly multer = new MulterPhoto();

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    try {
      return await this.multer.intercept(context, next);
    } catch (error: unknown) {
      if (error instanceof PayloadTooLargeException) {
        throw new PayloadTooLargeException(PHOTO_TOO_LARGE_MESSAGE);
      }

      throw error;
    }
  }
}

/**
 * The text half of a photo upload: the record's `version` (A8), sent as a
 * multipart field beside the file.
 *
 * Multipart fields arrive as strings, so `@Type(() => Number)` turns `"3"`
 * into `3` before `VersionedWriteDto`'s own checks run; without it every
 * upload would be refused as a malformed version. The decorator is applied
 * to the inherited property after the class, because redeclaring `version`
 * in a subclass to decorate it would shadow the base class's field.
 */
export class PhotoUploadRequest extends VersionedWriteDto {}

Type(() => Number)(PhotoUploadRequest.prototype, 'version');

/**
 * A photo upload route: the interceptor, and the multipart body documented
 * once for every photo. The staff and menu photos are versioned writes
 * (A8) and carry `version` beside the file; a customer's own photo
 * (`versioned: false`) does not, because `Customer` has no `version`
 * (A8 does not list it: a customer's profile is edited by that customer
 * alone).
 */
export function PhotoUpload(
  options: { versioned?: boolean } = {},
): MethodDecorator {
  const versioned = options.versioned ?? true;

  return applyDecorators(
    UseInterceptors(PhotoUploadInterceptor),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      schema: {
        type: 'object',
        properties: {
          [PHOTO_FIELD]: {
            type: 'string',
            format: 'binary',
            description:
              'JPEG, PNG or WebP, 5MB or smaller, judged by its bytes and ' +
              'never by its name.',
          },
          ...(versioned
            ? {
                version: {
                  type: 'integer',
                  minimum: 0,
                  description:
                    'The `version` of the record as the client last read ' +
                    'it; an older one is refused with 409 "This record ' +
                    'changed. Refresh and try again."',
                },
              }
            : {}),
        },
        required: versioned ? [PHOTO_FIELD, 'version'] : [PHOTO_FIELD],
      },
    }),
  );
}
