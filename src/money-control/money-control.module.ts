import { Module } from '@nestjs/common';
import { MoneyControlService } from './money-control.service';

/**
 * The Owner's money rules (plan §6.2). Not global, like `AuditModule`: the
 * modules that import this one are the modules whose commands spend, give
 * away or approve money, and that list is worth being able to read.
 */
@Module({
  providers: [MoneyControlService],
  exports: [MoneyControlService],
})
export class MoneyControlModule {}
