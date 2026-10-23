import { Module } from '@nestjs/common';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { CncConfigService } from '../config/cnc.config';
import { MailModule } from '../mail/mail.module';
import { CheckoutPaymentsService } from './checkout-payments.service';
import { HttpPaystackClient } from './http-paystack-client';
import { LocalPaystackClient } from './local-paystack-client';
import { PaymentEventService } from './payment-event.service';
import { PAYSTACK_CLIENT, type PaystackClient } from './paystack-client';
import { PaymentsController } from './payments.controller';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * The Paystack client by deployment, chosen once (as `mailTransportFor`
 * chooses the mail transport): a local run calls nobody, staging and
 * production call Paystack with CNC's own key. A built container refuses
 * `CNC_ENV=local`, so the offline client cannot reach a deployed service.
 * Every e2e app replaces it with a fake (`createTestApp`).
 */
export function paystackClientFor(
  config: Pick<CncConfigService, 'cncEnv' | 'paystackKey'>,
): PaystackClient {
  return config.cncEnv === 'local'
    ? new LocalPaystackClient()
    : new HttpPaystackClient(() => config.paystackKey);
}

/**
 * CNC's Paystack account (plan §8, C7): the client, the webhook, its
 * ledger and dispatcher, and what a confirmed payment does to a checkout.
 * The checkout itself (`POST /checkouts`) lives in `OrderingModule`, which
 * imports this one for the client.
 */
@Module({
  imports: [MailModule],
  controllers: [PaymentsController],
  providers: [
    {
      provide: PAYSTACK_CLIENT,
      inject: [CncConfigService],
      useFactory: paystackClientFor,
    },
    PaymentEventService,
    CheckoutPaymentsService,
    WebhookDispatcherService,
    ClientAddressThrottlerGuard,
  ],
  exports: [
    PAYSTACK_CLIENT,
    CheckoutPaymentsService,
    PaymentEventService,
    WebhookDispatcherService,
  ],
})
export class PaymentsModule {}
