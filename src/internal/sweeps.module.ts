import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReceptionModule } from '../reception/reception.module';
import { RetentionSweepService } from './retention-sweep.service';
import { SweepsController } from './sweeps.controller';
import { SweepTokenGuard } from './sweep-token.guard';
import { TokensSweepService } from './tokens-sweep.service';

/**
 * The sweep routes (plan §5.5). The door, not the work: each later sweep's
 * work belongs to its own module, which exports the service this module's
 * controller calls, as TAY's does. The tokens sweep is here because the
 * tables it tidies have no service of their own to hold it;
 * `IdempotencyService` and the Prisma client are global. The retention
 * sweep (C8-5) is here for the same reason: deleting a row past its period
 * is no rule of the enquiries' or attendance's modules, which never delete.
 */
@Module({
  // The messages sweep's work is the outbound queue's (`MailModule`); the
  // reminders sweep's is Reception's (`ReservationRemindersService`); the
  // checkouts and payments sweeps' are Payments' (`PaymentSweepsService`).
  imports: [MailModule, ReceptionModule, PaymentsModule],
  controllers: [SweepsController],
  providers: [SweepTokenGuard, TokensSweepService, RetentionSweepService],
})
export class SweepsModule {}
