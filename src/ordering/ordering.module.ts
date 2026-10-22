import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { OrderingController } from './ordering.controller';
import { OrderingService } from './ordering.service';

/**
 * Online ordering (plan §5.1). From C6-4 the public reads, the config and
 * the slots; C7 adds the quote, the checkout and Paystack here.
 */
@Module({
  imports: [SettingsModule],
  controllers: [OrderingController],
  providers: [OrderingService],
  exports: [OrderingService],
})
export class OrderingModule {}
