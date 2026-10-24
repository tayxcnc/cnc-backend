import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { OnlineOrdersModule } from '../online-orders/online-orders.module';
import { CheckoutPaymentsService } from './checkout-payments.service';
import { PaymentEventService } from './payment-event.service';
import { PaymentSweepsService } from './payment-sweeps.service';
import { PaystackClientModule } from './paystack-client.module';
import { PaymentsController } from './payments.controller';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

/**
 * CNC's Paystack account (plan §8, C7): the client (from
 * `PaystackClientModule`, re-exported), the webhook, its ledger and
 * dispatcher, and what a confirmed payment does to a checkout. The
 * checkout itself (`POST /checkouts`) lives in `OrderingModule`, which
 * imports this one for the client.
 */
@Module({
  imports: [MailModule, OnlineOrdersModule, PaystackClientModule],
  controllers: [PaymentsController],
  providers: [
    PaymentEventService,
    CheckoutPaymentsService,
    WebhookDispatcherService,
    PaymentSweepsService,
  ],
  exports: [
    PaystackClientModule,
    CheckoutPaymentsService,
    PaymentEventService,
    WebhookDispatcherService,
    PaymentSweepsService,
  ],
})
export class PaymentsModule {}
