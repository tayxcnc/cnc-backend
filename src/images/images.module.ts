import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ImageResizerService } from './image-resizer.service';
import { PhotoStore } from './photo-store.service';
import { PhotoUploadInterceptor } from './photo-upload';

/**
 * The one images module (A17, plan §11): byte inspection, resizing and the
 * private bucket, behind `PhotoStore`. Staff & Access and Menu & Prices
 * import it; the customer photo (C6) will too. Nothing else imports
 * `StorageModule`, so this is the only door into the bucket.
 */
@Module({
  imports: [StorageModule],
  providers: [ImageResizerService, PhotoStore, PhotoUploadInterceptor],
  exports: [PhotoStore, PhotoUploadInterceptor],
})
export class ImagesModule {}
