import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
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
  ACCOUNT_DELETE_LIMIT,
  CodeRequestThrottle,
  CUSTOMER_PHOTO_LIMIT,
  CustomerWriteThrottle,
  ProfileSaveThrottle,
  SignInThrottle,
} from '../auth/auth-throttle';
import type { CustomerPrincipal } from '../auth/customer-principal';
import { CurrentCustomer } from '../auth/decorators/current-customer.decorator';
import { CncCustomerGuard } from '../auth/guards/cnc-customer.guard';
import {
  clearRefreshCookie,
  CUSTOMER_REFRESH_COOKIE,
} from '../auth/refresh-cookie';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { ClientAddressThrottlerGuard } from '../common/throttler/client-address-throttler.guard';
import { CncConfigService } from '../config/cnc.config';
import { PhotoUpload } from '../images/photo-upload';
import type { UploadedImageFile } from '../images/uploaded-image';
import { CustomerDeletionService } from './customer-deletion.service';
import { CustomerEmailService } from './customer-email.service';
import { CustomerService } from './customer.service';
import {
  ChangeEmailCodeRequest,
  ChangeEmailVerifyRequest,
} from './dto/change-email.request';
import { CodeSentResponse } from './dto/customer-auth.dto';
import { CustomerProfileResponse } from './dto/customer-profile.response';
import { UpdateMeRequest } from './dto/update-me.request';

const UNAUTHORISED = {
  status: 401,
  description: 'No valid customer token, or the account is gone or deleted.',
  type: ApiErrorResponse,
} as const;

const STAFF_TOKEN = {
  status: 403,
  description: 'A staff token.',
  type: ApiErrorResponse,
} as const;

/** The 429 of a throttled route; `counted` says what is counted. */
function tooMany(counted: string) {
  return {
    status: 429,
    description: `Too many requests (${counted}). The body says what to do.`,
    type: ApiErrorResponse,
  } as const;
}

/**
 * The signed-in customer's own account (plan §5.2, C6-3): the profile and
 * its changes, the email change by code, the photo, and deleting the
 * account (Q36).
 *
 * Every answer is the customer's personal data and carries
 * `Cache-Control: no-store`, so no shared cache or back button keeps a copy
 * after sign-out.
 */
@ApiTags('Customer account')
@ApiBearerAuth()
@UseGuards(CncCustomerGuard)
@Controller('me')
export class CustomerMeController {
  constructor(
    private readonly customers: CustomerService,
    private readonly email: CustomerEmailService,
    private readonly deletion: CustomerDeletionService,
    private readonly config: CncConfigService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'getCustomerProfile',
    summary: 'The signed-in customer',
    description: 'A 401 means nobody is signed in (`getProfile` → null).',
  })
  @ApiResponse({ status: 200, type: CustomerProfileResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  me(
    @CurrentCustomer() customer: CustomerPrincipal,
  ): Promise<CustomerProfileResponse> {
    return this.customers.profile(customer.id);
  }

  @Patch()
  @UseGuards(ClientAddressThrottlerGuard)
  @ProfileSaveThrottle()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'updateCustomerProfile',
    summary: 'Change your profile',
    description:
      'Each field changes only when sent: `name`, `phone` (null or blank ' +
      'removes it), `address` (the whole address with its zone and ' +
      'landmark, or null to remove it) and `prefs` (only the switches ' +
      'sent). Never the email or the photo, which have their own routes. ' +
      'Returns the whole profile.',
  })
  @ApiResponse({ status: 200, type: CustomerProfileResponse })
  @ApiResponse({
    status: 400,
    description:
      'The field’s sentence: "Add your name.", "Keep your name to 80 ' +
      'characters.", "Enter a Nigerian phone number, for example 0803 123 ' +
      '4567.", "Keep at least a phone number or an email.", "Choose where ' +
      'we are delivering to.", "Add the street, area and town.", "Add a ' +
      'nearby landmark so our rider can find you, for example a church, ' +
      'school or filling station.", "Keep each part of the address to 120 ' +
      'characters.", "Choose on or off for each notification.", "Choose ' +
      'how we send your updates.", "News and offers are not available ' +
      'yet.", "Updates by SMS are not available yet." or "Add an email ' +
      'address in Your Details to receive updates by email."; or a field ' +
      'this route does not take.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse({
    status: 409,
    description: '"This phone number is already on another CNC account."',
    type: ApiErrorResponse,
  })
  @ApiResponse(tooMany('per customer, 30 in 15 minutes'))
  update(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Body() request: UpdateMeRequest,
  ): Promise<CustomerProfileResponse> {
    return this.customers.update(customer.id, request);
  }

  @Post('email/code')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientAddressThrottlerGuard)
  @CodeRequestThrottle()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'requestCustomerEmailChangeCode',
    summary: 'Email a code to a new address',
    description:
      'The first step of changing the sign-in email. Sends a six-digit code ' +
      'to the new address; the account keeps its email until the code is ' +
      'verified. The same limits as the sign-in code: 10 minutes, 5 tries, ' +
      'another code for the same address only after 30 seconds, at most 5 ' +
      'codes per address and 30 per client address in 15 minutes. The ' +
      'answer never contains the code, and does not say whether the ' +
      'address belongs to another account.',
  })
  @ApiResponse({ status: 200, type: CodeSentResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Check the email address." or "That is already your email address."',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse(
    tooMany(
      'inside 30 seconds of the last code: "Please wait N seconds before ' +
        'asking for a new code."; over a cap: "Too many attempts. Wait a ' +
        'few minutes and try again."',
    ),
  )
  requestEmailCode(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Body() request: ChangeEmailCodeRequest,
    @Req() httpRequest: Request,
  ): Promise<CodeSentResponse> {
    return this.email.requestCode(
      customer.id,
      request.email,
      clientAddressOf(httpRequest),
    );
  }

  @Post('email/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ClientAddressThrottlerGuard)
  @SignInThrottle()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'verifyCustomerEmailChange',
    summary: 'Verify the code and change the email',
    description:
      'Checks the newest code this account asked for at the new address. ' +
      'On success the account signs in with the new email from now on, ' +
      'the old address is told of the change, and the profile is returned. ' +
      'Sessions are kept.',
  })
  @ApiResponse({ status: 200, type: CustomerProfileResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Check the email address.", "Enter the 6 digit code.", "Ask for a ' +
      'new code.", "That code has expired. Ask for a new one.", "That code ' +
      'is not right. N tries left." or "Too many attempts. Ask for a new ' +
      'code."',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse({
    status: 409,
    description: '"That email address is already on another CNC account."',
    type: ApiErrorResponse,
  })
  @ApiResponse(tooMany('per email at one address, per email, per address'))
  verifyEmailChange(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Body() request: ChangeEmailVerifyRequest,
  ): Promise<CustomerProfileResponse> {
    return this.email.verify(customer.id, request.email, request.code);
  }

  @Post('photo')
  @HttpCode(HttpStatus.OK)
  // Guards run before the upload interceptor: a refused request is not
  // read into memory or decoded.
  @UseGuards(ClientAddressThrottlerGuard)
  @CustomerWriteThrottle(CUSTOMER_PHOTO_LIMIT)
  @PhotoUpload({ versioned: false })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'replaceCustomerPhoto',
    summary: 'Replace your photo',
    description:
      'Multipart, the file in `photo`. Judged by its bytes, cropped to a ' +
      'square of at most 256 pixels with every piece of metadata removed ' +
      '(a phone photo’s GPS position included), and stored privately; the ' +
      'profile returned carries a short-lived signed link. The photo it ' +
      'replaces is deleted.',
  })
  @ApiResponse({ status: 200, type: CustomerProfileResponse })
  @ApiResponse({
    status: 400,
    description: 'No file, or an image too large to decode.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse({
    status: 413,
    description: 'Larger than 5MB.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 415,
    description: 'Not a JPEG, PNG or WebP by its bytes.',
    type: ApiErrorResponse,
  })
  @ApiResponse(tooMany('per customer'))
  replacePhoto(
    @CurrentCustomer() customer: CustomerPrincipal,
    @UploadedFile() photo: UploadedImageFile | undefined,
  ): Promise<CustomerProfileResponse> {
    return this.customers.replacePhoto(customer.id, photo);
  }

  @Delete('photo')
  @UseGuards(ClientAddressThrottlerGuard)
  @CustomerWriteThrottle(CUSTOMER_PHOTO_LIMIT)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'removeCustomerPhoto',
    summary: 'Remove your photo',
    description: 'The photo is deleted; removing none is not an error.',
  })
  @ApiResponse({ status: 200, type: CustomerProfileResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse(tooMany('per customer'))
  removePhoto(
    @CurrentCustomer() customer: CustomerPrincipal,
  ): Promise<CustomerProfileResponse> {
    return this.customers.removePhoto(customer.id);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ClientAddressThrottlerGuard)
  @CustomerWriteThrottle(ACCOUNT_DELETE_LIMIT)
  @ApiOperation({
    operationId: 'deleteCustomerAccount',
    summary: 'Delete your account',
    description:
      'Q36: the account is anonymised, not erased. Its name, email, phone, ' +
      'address, photo and preferences are removed; its bookings and bills ' +
      'keep existing under "Deleted customer" with no contact details; its ' +
      'notifications, codes and waiting emails are removed; every session ' +
      'ends and the `cnc_refresh_token` cookie is cleared. Signing in with ' +
      'the same email afterwards starts a new, empty account. Refused while ' +
      'a booking is still to come or an order is in progress.',
  })
  @ApiResponse({ status: 204, description: 'The account is deleted.' })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse({
    status: 409,
    description:
      '"You have a reservation still to come or an order in progress. ' +
      'Cancel it, or wait until it is complete, then delete your account."',
    type: ApiErrorResponse,
  })
  @ApiResponse(tooMany('per customer'))
  async deleteAccount(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.deletion.deleteAccount(customer.id);

    clearRefreshCookie(
      response,
      CUSTOMER_REFRESH_COOKIE,
      this.config.secureCookies,
    );
  }
}
