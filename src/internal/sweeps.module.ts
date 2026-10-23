import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { ReceptionModule } from '../reception/reception.module';
import { SweepsController } from './sweeps.controller';
import { SweepTokenGuard } from './sweep-token.guard';
import { TokensSweepService } from './tokens-sweep.service';

/**
 * The sweep routes (plan §5.5). The door, not the work: each later sweep's
 * work belongs to its own module, which exports the service this module's
 * controller calls, as TAY's does. The tokens sweep is here because the
 * tables it tidies have no service of their own to hold it;
 * `IdempotencyService` and the Prisma client are global.
 */
@Module({
  // The messages sweep's work is the outbound queue's (`MailModule`); the
  // reminders sweep's is Reception's (`ReservationRemindersService`).
  imports: [MailModule, ReceptionModule],
  controllers: [SweepsController],
  providers: [SweepTokenGuard, TokensSweepService],
})
export class SweepsModule {}
