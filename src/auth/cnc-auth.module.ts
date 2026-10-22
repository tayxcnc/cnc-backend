import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from '../audit/audit.module';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { CncConfigService } from '../config/cnc.config';
import { MoneyControlModule } from '../money-control/money-control.module';
import {
  AUTH_ATTEMPT_LIMIT,
  AUTH_ATTEMPT_WINDOW_MS,
  THROTTLERS,
  TOO_MANY_ATTEMPTS_MESSAGE,
} from './auth-throttle';
import { CncTokenService } from './cnc-token.service';
import { CncCustomerGuard } from './guards/cnc-customer.guard';
import { CncStaffGuard } from './guards/cnc-staff.guard';
import { StaffAuthController } from './staff-auth.controller';
import { StaffAuthService } from './staff-auth.service';
import { StaffPasswordResetController } from './staff-password-reset.controller';
import {
  CNC_JWT_STRATEGY,
  CncJwtStrategy,
} from './strategies/cnc-jwt.strategy';

/**
 * CNC's authentication realm: the staff session routes, the admin password
 * reset, and the primitives other modules build on (`CncTokenService`,
 * `CncStaffGuard`, `@Roles`, `@CurrentStaff`, and from C6 the customer
 * realm's `CncCustomerGuard` and `@CurrentCustomer`). The customer session
 * routes live in `CustomersModule`, which imports this one and runs its
 * throttled routes against the `ThrottlerModule` registered here: that
 * module is global, so a second registration would replace these counts
 * for every route rather than add its own.
 *
 * Tokens are signed HS256 with `CncConfigService.jwtSecret`, which refuses
 * to boot on a placeholder or a value under 32 characters. TAY's realm has
 * its own secret, so a TAY token presented here fails verification (401).
 *
 * `ThrottlerModule` is registered here, with in-memory storage (plan A18:
 * no Redis at launch). It provides the options and storage
 * `ClientAddressThrottlerGuard` resolves against and registers no
 * APP_GUARD, so the limits reach only the routes that apply the guard by
 * hand (`auth-throttle.ts`). `ThrottlerModule` is `@Global`, so this is the
 * one registration: a module that throttles its own routes provides the
 * guard and names its counts with `@Throttle`, and never calls `forRoot`
 * again (corrected in C6; a second `forRoot` replaces the options for
 * every route).
 *
 * `StaffAuthService` decides who gets a session and stays private to this
 * module. It audits the password change and the admin reset through
 * `AuditModule`, and takes the Manager-and-Owner account rule from
 * `MoneyControlModule`.
 */
@Module({
  imports: [
    AuditModule,
    MoneyControlModule,
    PassportModule.register({ defaultStrategy: CNC_JWT_STRATEGY }),
    JwtModule.registerAsync({
      inject: [CncConfigService],
      useFactory: (config: CncConfigService) => ({
        secret: config.jwtSecret,
        signOptions: { algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
    // Every named count, at the tightest number; each route's decorator in
    // `auth-throttle.ts` sets its own numbers and skips the counts it does
    // not use.
    ThrottlerModule.forRoot({
      throttlers: Object.values(THROTTLERS).map((name) => ({
        name,
        limit: AUTH_ATTEMPT_LIMIT,
        ttl: AUTH_ATTEMPT_WINDOW_MS,
      })),
      errorMessage: TOO_MANY_ATTEMPTS_MESSAGE,
    }),
  ],
  controllers: [StaffAuthController, StaffPasswordResetController],
  providers: [
    CncJwtStrategy,
    CncTokenService,
    CncStaffGuard,
    CncCustomerGuard,
    StaffAuthService,
    ClientAddressThrottlerGuard,
  ],
  exports: [CncTokenService, CncStaffGuard, CncCustomerGuard],
})
export class CncAuthModule {}
