import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';

/**
 * `IdempotencyService` for every module that has a route taking
 * `Idempotency-Key` (A9): order create, part payment, settle, online
 * balance, web checkout and reservation create. Global, like the Prisma
 * module it depends on, so each of those modules uses it without importing
 * this one.
 */
@Global()
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
