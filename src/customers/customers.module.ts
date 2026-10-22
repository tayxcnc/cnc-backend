import { Module } from '@nestjs/common';
import { CncAuthModule } from '../auth/cnc-auth.module';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { ImagesModule } from '../images/images.module';
import { MailModule } from '../mail/mail.module';
import { CustomerAuthController } from './customer-auth.controller';
import { CustomerAuthService } from './customer-auth.service';
import { CustomerDeletionService } from './customer-deletion.service';
import { CustomerEmailService } from './customer-email.service';
import { CustomerMeController } from './customer-me.controller';
import { CustomerService } from './customer.service';
import { OtpService } from './otp.service';

/**
 * The customer side's people (C6): the email-code sign-in and session
 * (`/auth/code`, `/auth/verify`, `/auth/refresh`, `/auth/sign-out`), the
 * account (`/me`: the profile, the email change, the photo, deleting the
 * account), and the services later cards build on: `CustomerService` (the
 * one creator of customers) and `OtpService` (codes for sign-in and the
 * email change).
 *
 * Tokens and the customer guard come from `CncAuthModule`; the throttled
 * routes count against the global `ThrottlerModule` that module registers.
 * Mail goes through `MailModule`'s outbound queue; photos are stored and
 * signed by `ImagesModule`'s `PhotoStore`.
 */
@Module({
  imports: [CncAuthModule, MailModule, ImagesModule],
  controllers: [CustomerAuthController, CustomerMeController],
  providers: [
    CustomerService,
    CustomerAuthService,
    CustomerEmailService,
    CustomerDeletionService,
    OtpService,
    ClientAddressThrottlerGuard,
  ],
  exports: [CustomerService, OtpService],
})
export class CustomersModule {}
