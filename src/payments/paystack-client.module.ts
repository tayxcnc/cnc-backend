import { Module } from '@nestjs/common';
import { CncConfigService } from '../config/cnc.config';
import { HttpPaystackClient } from './http-paystack-client';
import { LocalPaystackClient } from './local-paystack-client';
import { PAYSTACK_CLIENT, type PaystackClient } from './paystack-client';

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
 * CNC's one Paystack client (`PAYSTACK_CLIENT`), in a module of its own so
 * both sides that call Paystack import it without importing each other:
 * `PaymentsModule` (initialize, verify) and, from C7-4,
 * `OnlineOrdersModule` (the card refunds of `online.balance`), which
 * `PaymentsModule` already imports for the web order a payment writes.
 */
@Module({
  providers: [
    {
      provide: PAYSTACK_CLIENT,
      inject: [CncConfigService],
      useFactory: paystackClientFor,
    },
  ],
  exports: [PAYSTACK_CLIENT],
})
export class PaystackClientModule {}
