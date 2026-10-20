import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { AUTH_ATTEMPT_LIMIT, AUTH_ATTEMPT_WINDOW_MS } from './auth-throttle';
import { CurrentStaff } from './decorators/current-staff.decorator';
import { Roles } from './decorators/roles.decorator';
import { TemporaryPasswordResponse } from './dto/temporary-password.response';
import { CncStaffGuard } from './guards/cnc-staff.guard';
import { StaffAuthService } from './staff-auth.service';
import type { StaffPrincipal } from './staff-principal';

/**
 * The admin password reset (plan §5.4, Staff & Access: "**new**
 * `POST /staff/people/:id/reset-password` (TAY's admin reset)").
 *
 * Its own controller because the path belongs to Staff & Access, which C3-6
 * builds under the same `staff/people` prefix, while the work is a
 * credential change that belongs with the rest of sign-in. C3-6 must not
 * declare this path again.
 */
@ApiTags('Staff & Access')
@ApiBearerAuth()
@Controller('staff/people')
export class StaffPasswordResetController {
  constructor(private readonly auth: StaffAuthService) {}

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  // Throttler first, then the staff guard: counted before the token is
  // looked at, like change-password.
  @UseGuards(ClientAddressThrottlerGuard, CncStaffGuard)
  @Throttle({
    default: { limit: AUTH_ATTEMPT_LIMIT, ttl: AUTH_ATTEMPT_WINDOW_MS },
  })
  @Roles()
  @ApiParam({
    name: 'id',
    description: 'Staff.id of the account whose password to reset.',
  })
  @ApiOperation({
    operationId: 'resetStaffPassword',
    summary: "Reset another person's password",
    description:
      'Managers only; only the Owner may reset a Manager or Owner account. ' +
      'Sets a new random temporary password, which the account must change ' +
      'at first sign-in, and ends every session the account holds. The old ' +
      'password stops working at once. The temporary password is returned ' +
      'once, to hand over in person; it cannot be read again. Use ' +
      'change-password for your own account. Ten resets per fifteen ' +
      'minutes per address.',
  })
  @ApiResponse({
    status: 200,
    description: 'Reset. Hand the temporary password to its holder.',
    type: TemporaryPasswordResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'No bearer token, or one that fails verification.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description:
      'Not a manager ("Your current staff role cannot perform this ' +
      'action."); a Manager or Owner account reset by a Manager ("Only the ' +
      'Owner can create or change Manager and Owner accounts."); your own ' +
      'account; a customer token; a deactivated account; or a pending ' +
      'password change.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description: '"Staff account not found."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Too many resets from this address in fifteen minutes.',
    type: ApiErrorResponse,
  })
  resetPassword(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') targetId: string,
  ): Promise<TemporaryPasswordResponse> {
    return this.auth.resetPassword(actor, targetId);
  }
}
