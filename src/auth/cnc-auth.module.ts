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
  TOO_MANY_ATTEMPTS_MESSAGE,
} from './auth-throttle';
import { CncTokenService } from './cnc-token.service';
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
 * `CncStaffGuard`, `@Roles`, `@CurrentStaff`).
 *
 * Tokens are signed HS256 with `CncConfigService.jwtSecret`, which refuses
 * to boot on a placeholder or a value under 32 characters. TAY's realm has
 * its own secret, so a TAY token presented here fails verification (401).
 *
 * `ThrottlerModule` is registered here, module-locally, with in-memory
 * storage (plan A18: no Redis at launch). It provides the options and
 * storage `ClientAddressThrottlerGuard` resolves against and registers no
 * APP_GUARD, so the limits reach only the routes that apply the guard by
 * hand (`auth-throttle.ts`). A module that later throttles its own routes
 * registers its own, as TAY's contact form does.
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
    ThrottlerModule.forRoot({
      throttlers: [{ limit: AUTH_ATTEMPT_LIMIT, ttl: AUTH_ATTEMPT_WINDOW_MS }],
      errorMessage: TOO_MANY_ATTEMPTS_MESSAGE,
    }),
  ],
  controllers: [StaffAuthController, StaffPasswordResetController],
  providers: [
    CncJwtStrategy,
    CncTokenService,
    CncStaffGuard,
    StaffAuthService,
    ClientAddressThrottlerGuard,
  ],
  exports: [CncTokenService, CncStaffGuard],
})
export class CncAuthModule {}
