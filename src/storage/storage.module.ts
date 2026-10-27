import { Module } from '@nestjs/common';
import { GcsMediaStorage } from './gcs-media-storage';
import { MediaStorage } from './media-storage';

/**
 * CNC's media bucket, bound to Google Cloud Storage.
 *
 * Imported by `ImagesModule` only, so the code that can write into the
 * bucket is one module a reviewer can find from the module graph. The e2e
 * harness overrides `MediaStorage` with an in-memory fake, so no suite
 * writes to a real bucket.
 */
@Module({
  providers: [{ provide: MediaStorage, useClass: GcsMediaStorage }],
  exports: [MediaStorage],
})
export class StorageModule {}
