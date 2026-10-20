import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { CncConfigModule } from './config/cnc-config.module';
import { DATABASE_HEALTH_PROBE } from './health/database-health.token';
import { HealthController } from './health/health.controller';
import { SERVICE_NAME } from './health/service-name.token';
import { CncPrismaModule } from './prisma/cnc-prisma.module';
import { CncPrismaService } from './prisma/cnc-prisma.service';

/**
 * Root module for the CNC Cloud Run service.
 *
 * CNC and TAY share no business data, no database, no auth realm and no
 * environment. Nothing in this repository imports TAY's code; TAY's backend
 * is the pattern source only.
 *
 * `ConfigModule` loads a local `.env` into `process.env` for development. It
 * is not a second way to read settings: `CncConfigService` is the only
 * reader, and on Cloud Run there is no `.env` (every value is mounted from
 * Secret Manager or `--set-env-vars`).
 *
 * Redis is not configured (plan A18), so the readiness route reports it as
 * `unconfigured`; only the database decides readiness.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    CncConfigModule,
    CncPrismaModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: SERVICE_NAME, useValue: 'cnc' },
    // The readiness route's database check, bound here so src/health stays
    // free of the Prisma client.
    { provide: DATABASE_HEALTH_PROBE, useExisting: CncPrismaService },
    // The global exception filter. Provided rather than set in bootstrap()
    // so it can inject, and so the e2e harness, which builds the app from
    // this module, gets it too.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class CncAppModule {}
