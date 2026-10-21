import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { CncConfigService } from '../config/cnc.config';
import {
  RefreshThrottle,
  SignedInCredentialThrottle,
  SignInThrottle,
} from './auth-throttle';
import { INVALID_REFRESH_TOKEN_MESSAGE } from './cnc-token.service';
import { CurrentStaff } from './decorators/current-staff.decorator';
import { PasswordChangeExempt } from './decorators/password-change-exempt.decorator';
import { ChangePasswordRequest } from './dto/change-password.request';
import { StaffAuthResponse } from './dto/staff-auth.response';
import { StaffSignInRequest } from './dto/staff-sign-in.request';
import { CncStaffGuard } from './guards/cnc-staff.guard';
import {
  clearRefreshCookie,
  clearShadowingRefreshCookies,
  isJsonContentType,
  readRefreshCookie,
  setRefreshCookie,
  STAFF_REFRESH_COOKIE,
} from './refresh-cookie';
import { StaffAuthService } from './staff-auth.service';
import type { StaffPrincipal } from './staff-principal';

/** A refresh with no staff cookie (400). TAY's wording. */
export const NO_STAFF_REFRESH_COOKIE_MESSAGE =
  'No staff refresh token was presented in a cookie.';

/** A refresh by cookie sent without JSON (403). TAY's wording. */
export const REFRESH_NEEDS_JSON_MESSAGE =
  'A refresh from the cookie must be sent with Content-Type: application/json.';

/** The 429 of a throttled route; `counted` says what the route counts. */
function tooMany(counted: string) {
  return {
    status: 429,
    description:
      `Too many attempts in fifteen minutes (${counted}). The body says to ` +
      'wait and try again.',
    type: ApiErrorResponse,
  } as const;
}

/**
 * The staff session (plan §5.3): sign-in, refresh, sign-out and
 * change-password under `/api/v1/auth/staff/`. Copied from the staff half of
 * TAY's `TayAuthController`.
 *
 * **No response body carries a refresh token.** It is written to the httpOnly
 * `cnc_staff_refresh_token` cookie through the helpers in `refresh-cookie.ts`,
 * the only writers of a cookie in this service, so the attributes of a set
 * and of the matching clear cannot drift.
 *
 * `@Res({ passthrough: true })` lets a handler write the cookie and still
 * return its body through Nest's normal serialisation.
 */
@ApiTags('Staff session')
@Controller('auth/staff')
export class StaffAuthController {
  constructor(
    private readonly auth: StaffAuthService,
    private readonly config: CncConfigService,
  ) {}

  /** `Secure` on every built container, staging included (A16). */
  private get isProduction(): boolean {
    return this.config.secureCookies;
  }

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientAddressThrottlerGuard)
  @SignInThrottle()
  @ApiOperation({
    operationId: 'staffSignIn',
    summary: 'Sign in with a work email and password',
    description:
      'Returns an access token (15 minutes) and the staff summary, and sets ' +
      'the refresh token in the httpOnly `cnc_staff_refresh_token` cookie ' +
      '(host-only, `SameSite=Lax`, `Path=/api/v1/auth`). An unknown email, a ' +
      'wrong password and a deactivated account all answer the identical ' +
      '401. When `staff.mustChangePassword` is true, go straight to ' +
      'change-password: every other staff route answers 403 until then. Ten ' +
      'attempts per fifteen minutes per email from one address, thirty per ' +
      'email from all addresses, and a hundred per address over all emails.',
  })
  @ApiResponse({
    status: 200,
    description: 'Signed in.',
    type: StaffAuthResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'The body failed validation.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      '"Invalid email or password." The same for an unknown email, a wrong ' +
      'password and a deactivated account.',
    type: ApiErrorResponse,
  })
  @ApiResponse(tooMany('per email at one address, per email, and per address'))
  async signIn(
    @Body() request: StaffSignInRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StaffAuthResponse> {
    const session = await this.auth.signIn(
      request,
      clientAddressOf(httpRequest),
    );

    setRefreshCookie(
      response,
      STAFF_REFRESH_COOKIE,
      session.refreshToken,
      this.isProduction,
    );

    return session.body;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  // Unauthenticated and state-changing (it spends a token), so it is
  // counted, per address, at a ceiling a venue full of devices stays far
  // below: a refused refresh signs a real person out.
  @UseGuards(ClientAddressThrottlerGuard)
  @RefreshThrottle()
  @ApiOperation({
    operationId: 'refreshStaffSession',
    summary: 'Rotate the staff refresh cookie',
    description:
      'Reads the `cnc_staff_refresh_token` cookie and no other (a TAY cookie ' +
      'is ignored), spends it, writes its replacement to the cookie, and ' +
      'returns a new access token with the staff summary. Each token works ' +
      'once; a used token presented again after a few seconds ends every ' +
      'session the account holds (a copy is being replayed). Must be sent ' +
      'with `Content-Type: application/json` (a CSRF defence: it forces a ' +
      'preflight). A deactivated account is refused, and so is a request ' +
      'carrying the cookie name twice.',
  })
  @ApiResponse({
    status: 200,
    description: 'The cookie was exchanged for a new session.',
    type: StaffAuthResponse,
  })
  @ApiResponse({
    status: 400,
    description:
      'No `cnc_staff_refresh_token` cookie. A cookie of any other name does ' +
      'not count.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'The token is unknown, expired, already used, or belongs to a ' +
      'deactivated account; or the cookie name came twice, when neither ' +
      'token is spent and both copies are cleared. One answer for all of ' +
      'them.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description:
      'Sent without `Content-Type: application/json`. The token is not spent.',
    type: ApiErrorResponse,
  })
  @ApiResponse(tooMany('per address'))
  async refresh(
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StaffAuthResponse> {
    const presented = readRefreshCookie(httpRequest, STAFF_REFRESH_COOKIE);

    if (presented.kind === 'absent') {
      throw new BadRequestException(NO_STAFF_REFRESH_COOKIE_MESSAGE);
    }

    if (!isJsonContentType(httpRequest.headers['content-type'])) {
      throw new ForbiddenException(REFRESH_NEEDS_JSON_MESSAGE);
    }

    // Two cookies of this name: one was planted by another tayxcnc.com host
    // (`readRefreshCookie`). Neither is spent, both are cleared, and the
    // person signs in again on a clean jar.
    if (presented.kind === 'shadowed') {
      clearShadowingRefreshCookies(
        response,
        STAFF_REFRESH_COOKIE,
        this.isProduction,
      );

      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    const session = await this.auth.refresh(presented.token);

    setRefreshCookie(
      response,
      STAFF_REFRESH_COOKIE,
      session.refreshToken,
      this.isProduction,
    );

    return session.body;
  }

  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  @PasswordChangeExempt()
  @UseGuards(CncStaffGuard)
  @ApiBearerAuth()
  @ApiOperation({
    operationId: 'staffSignOut',
    summary: 'Sign out on every device',
    description:
      'Revokes every staff refresh token the caller holds and clears the ' +
      '`cnc_staff_refresh_token` cookie on this browser. A customer session ' +
      'in the same browser is untouched. Access tokens already issued stay ' +
      'valid until they expire (15 minutes at most). Allowed while a ' +
      'password change is pending.',
  })
  @ApiResponse({ status: 204, description: 'Signed out everywhere.' })
  @ApiResponse({
    status: 401,
    description: 'No bearer token, or one that fails verification.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'A customer token, or a deactivated staff account.',
    type: ApiErrorResponse,
  })
  async signOut(
    @CurrentStaff() actor: StaffPrincipal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    // Revoke first, then clear: the revocation is what signs the person out,
    // and it must not depend on the browser honouring the clear.
    await this.auth.signOut(actor.id);

    clearRefreshCookie(response, STAFF_REFRESH_COOKIE, this.isProduction);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @PasswordChangeExempt()
  // The staff guard runs first and the throttler counts the account it
  // verified: the route takes a current password, so it is a place to guess
  // one, and only a valid token's holder can guess. Counted by address, a
  // burst without a token used up the whole venue's attempts.
  @UseGuards(CncStaffGuard, ClientAddressThrottlerGuard)
  @SignedInCredentialThrottle()
  @ApiBearerAuth()
  @ApiOperation({
    operationId: 'changeStaffPassword',
    summary: 'Change your own password',
    description:
      'Needs the current password as well as the token. Clears ' +
      '`mustChangePassword`, ends every existing session, and starts a ' +
      'fresh one: a new access token in the body and a new ' +
      '`cnc_staff_refresh_token` cookie, so the caller stays signed in. ' +
      'Allowed while a password change is pending (it is the route that ' +
      'clears it). Ten attempts per fifteen minutes per account.',
  })
  @ApiResponse({
    status: 200,
    description: 'Changed. The session returned replaces every earlier one.',
    type: StaffAuthResponse,
  })
  @ApiResponse({
    status: 400,
    description:
      'The body failed validation: no current password, a new password ' +
      'under 8 characters, or the new password equals the current one.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'No bearer token, one that fails verification, or a wrong current ' +
      'password ("The current password is incorrect.").',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'A customer token, or a deactivated staff account.',
    type: ApiErrorResponse,
  })
  @ApiResponse(tooMany('per account'))
  async changePassword(
    @CurrentStaff() actor: StaffPrincipal,
    @Body() request: ChangePasswordRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StaffAuthResponse> {
    const session = await this.auth.changePassword(
      actor,
      request,
      clientAddressOf(httpRequest),
    );

    setRefreshCookie(
      response,
      STAFF_REFRESH_COOKIE,
      session.refreshToken,
      this.isProduction,
    );

    return session.body;
  }
}
