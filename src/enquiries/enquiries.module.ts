import { Module } from '@nestjs/common';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { MailModule } from '../mail/mail.module';
import { EnquiriesController } from './enquiries.controller';
import { EnquiriesService } from './enquiries.service';

/**
 * The website's enquiry forms (card C6-7): `POST /enquiries` and
 * `POST /group-enquiries`, stored and emailed to CNC through `MailModule`'s
 * queue. The throttle runs against the one `ThrottlerModule`
 * `CncAuthModule` registers (it is global; see that module's note).
 */
@Module({
  imports: [MailModule],
  controllers: [EnquiriesController],
  providers: [EnquiriesService, ClientAddressThrottlerGuard],
})
export class EnquiriesModule {}
