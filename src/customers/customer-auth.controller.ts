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
import {
  CodeRequestThrottle,
  CUSTOMER_SIGN_OUT_LIMIT,
  CustomerWriteThrottle,
  RefreshThrottle,
  SignInThrottle,
} from '../auth/auth-throttle';
import { INVALID_REFRESH_TOKEN_MESSAGE } from '../auth/cnc-token.service';
import type { CustomerPrincipal } from '../auth/customer-principal';
import { CurrentCustomer } from '../auth/decorators/current-customer.decorator';
import { CncCustomerGuard } from '../auth/guards/cnc-customer.guard';
import {
  clearRefreshCookie,
  clearShadowingRefreshCookies,
  CUSTOMER_REFRESH_COOKIE,
  isJsonContentType,
  readRefreshCookie,
  setRefreshCookie,
} from '../auth/refresh-cookie';
import { REFRESH_NEEDS_JSON_MESSAGE } from '../auth/staff-auth.controller';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { CncConfigService } from '../config/cnc.config';
import { CustomerAuthService } from './customer-auth.service';
import {
  CodeSentResponse,
  CustomerSessionResponse,
  CustomerSignInResponse,
  RequestCodeRequest,
  VerifyCodeRequest,
} from './dto/customer-auth.dto';

/** A customer refresh with no customer cookie (400). TAY's wording. */
export const NO_REFRESH_COOKIE_MESSAGE =
  'No refresh token was presented in a cookie.';

/** The 429 of a throttled route; `counted` says what the route counts. */
function tooMany(counted: string) {
  return {
    status: 429,
    description: `Too many requests (${counted}). The body says what to do.`,
    type: ApiErrorResponse,
  } as const;
}

/**
 * The customer session (plan §5.2, A15, A16): ask for an email code,
 * verify it, refresh, sign out, under `/api/v1/auth/`. The staff session
 * (`/api/v1/auth/staff/…`) is the model, in its own realm: a customer token
 * and the `cnc_refresh_token` cookie, never the staff ones.
 *
 * **No response body carries a refresh token, and none carries a code.**
 * The refresh token goes to the httpOnly cookie through `refresh-cookie.ts`;
 * the code goes to the email and nowhere else.
 */
@ApiTags('Customer session')
@Controller('auth')
export class CustomerAuthController {
  constructor(
    private readonly auth: CustomerAuthService,
    private readonly config: CncConfigService,
  ) {}

  /** `Secure` on every built container, staging included (A16). */
  private get isProduction(): boolean {
    return this.config.secureCookies;
  }

  @Post('code')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientAddressThrottlerGuard)
  @CodeRequestThrottle()
  @ApiOperation({
    operationId: 'requestCustomerCode',
    summary: 'Email a six-digit sign-in code',
    description:
      'Sends a code to the email, which works for 10 minutes and allows 5 ' +
      'tries. A new email creates the account when its code is verified. ' +
      'The answer never contains the code, and is the same whether or not ' +
      'the email has an account. Another code for the same email only after ' +
      '30 seconds; at most 5 codes per email and 30 per address in 15 ' +
      'minutes. If the email cannot be sent at once it is retried; the ' +
      'answer does not change.',
  })
  @ApiResponse({ status: 200, type: CodeSentResponse })
  @ApiResponse({
    status: 400,
    description: '"Enter your email address."',
    type: ApiErrorResponse,
  })
  @ApiResponse(
    tooMany(
      'inside 30 seconds of the last code: "Please wait N seconds before ' +
        'asking for a new code."; over the email or address cap: "Too many ' +
        'attempts. Wait a few minutes and try again."',
    ),
  )
  requestCode(
    @Body() request: RequestCodeRequest,
    @Req() httpRequest: Request,
  ): Promise<CodeSentResponse> {
    return this.auth.requestCode(request.email, clientAddressOf(httpRequest));
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientAddressThrottlerGuard)
  @SignInThrottle()
  @ApiOperation({
    operationId: 'verifyCustomerCode',
    summary: 'Verify the code and sign in',
    description:
      'Checks the newest code sent to the email. On success, creates the ' +
      'account if this is its first sign-in, returns an access token (15 ' +
      'minutes), the profile and `isNew`, and sets the refresh token in the ' +
      'httpOnly `cnc_refresh_token` cookie (host-only, `SameSite=Lax`, ' +
      '`Path=/api/v1/auth`). When `isNew` is true, ask for the name and save ' +
      'it with `PATCH /me`. Ten tries per fifteen minutes per email from one ' +
      'address, thirty per email from all addresses, a hundred per address.',
  })
  @ApiResponse({ status: 200, type: CustomerSignInResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter your email address.", "Enter the 6 digit code.", "Ask for a ' +
      'new code.", "That code has expired. Ask for a new one.", "That code ' +
      'is not right. N tries left." or "Too many attempts. Ask for a new ' +
      'code."',
    type: ApiErrorResponse,
  })
  @ApiResponse(tooMany('per email at one address, per email, per address'))
  async verify(
    @Body() request: VerifyCodeRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerSignInResponse> {
    const session = await this.auth.verify(request.email, request.code);

    setRefreshCookie(
      response,
      CUSTOMER_REFRESH_COOKIE,
      session.refreshToken,
      this.isProduction,
    );

    return session.body;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientAddressThrottlerGuard)
  @RefreshThrottle()
  @ApiOperation({
    operationId: 'refreshCustomerSession',
    summary: 'Rotate the customer refresh cookie',
    description:
      'Reads the `cnc_refresh_token` cookie and no other (a TAY cookie or the ' +
      'staff cookie is ignored), spends it, writes its replacement, and ' +
      'returns a new access token with the profile. This is how the app ' +
      'restores a session on load. Each token works once; a used token ' +
      'presented again after a few seconds ends every session the customer ' +
      'holds. Must be sent with `Content-Type: application/json` (a CSRF ' +
      'defence). A request carrying the cookie name twice is refused.',
  })
  @ApiResponse({ status: 200, type: CustomerSessionResponse })
  @ApiResponse({
    status: 400,
    description:
      'No `cnc_refresh_token` cookie: "No refresh token was presented in a ' +
      'cookie."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 401,
    description:
      'The token is unknown, expired, used, of the staff realm, or the ' +
      "customer's account is gone; or the cookie name came twice.",
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'Sent without `Content-Type: application/json`.',
    type: ApiErrorResponse,
  })
  @ApiResponse(tooMany('per address'))
  async refresh(
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerSessionResponse> {
    const presented = readRefreshCookie(httpRequest, CUSTOMER_REFRESH_COOKIE);

    if (presented.kind === 'absent') {
      throw new BadRequestException(NO_REFRESH_COOKIE_MESSAGE);
    }

    if (!isJsonContentType(httpRequest.headers['content-type'])) {
      throw new ForbiddenException(REFRESH_NEEDS_JSON_MESSAGE);
    }

    // Two cookies of this name: one was planted by another tayxcnc.com host.
    // Neither is spent, both are cleared (`readRefreshCookie`).
    if (presented.kind === 'shadowed') {
      clearShadowingRefreshCookies(
        response,
        CUSTOMER_REFRESH_COOKIE,
        this.isProduction,
      );

      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    const session = await this.auth.refresh(presented.token);

    setRefreshCookie(
      response,
      CUSTOMER_REFRESH_COOKIE,
      session.refreshToken,
      this.isProduction,
    );

    return session.body;
  }

  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  // The customer guard first, so only a verified customer is counted.
  @UseGuards(CncCustomerGuard, ClientAddressThrottlerGuard)
  @CustomerWriteThrottle(CUSTOMER_SIGN_OUT_LIMIT)
  @ApiBearerAuth()
  @ApiOperation({
    operationId: 'customerSignOut',
    summary: 'Sign out on every device',
    description:
      'Revokes every refresh token the customer holds and clears the ' +
      '`cnc_refresh_token` cookie on this browser. A staff session in the ' +
      'same browser is untouched. Access tokens already issued stay valid ' +
      'until they expire (15 minutes at most).',
  })
  @ApiResponse({ status: 204, description: 'Signed out everywhere.' })
  @ApiResponse({
    status: 401,
    description: 'No bearer token, or one that fails verification.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'A staff token.',
    type: ApiErrorResponse,
  })
  @ApiResponse(tooMany('per customer'))
  async signOut(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    // Revoke first, then clear: the revocation is what signs the person
    // out, and it must not depend on the browser honouring the clear.
    await this.auth.signOut(customer.id);

    clearRefreshCookie(response, CUSTOMER_REFRESH_COOKIE, this.isProduction);
  }
}
