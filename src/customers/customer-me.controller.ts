import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { CustomerPrincipal } from '../auth/customer-principal';
import { CurrentCustomer } from '../auth/decorators/current-customer.decorator';
import { CncCustomerGuard } from '../auth/guards/cnc-customer.guard';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { CustomerService } from './customer.service';
import { CustomerProfileResponse } from './dto/customer-profile.response';
import { UpdateMeRequest } from './dto/update-me.request';

/**
 * The signed-in customer's own profile (plan §5.2). C6-2 builds the read
 * and the name, which the first-time name step saves; C6-3 adds the
 * phone, the address, the preferences, the email change and the photo.
 */
@ApiTags('Customer account')
@ApiBearerAuth()
@UseGuards(CncCustomerGuard)
@Controller('me')
export class CustomerMeController {
  constructor(private readonly customers: CustomerService) {}

  @Get()
  @ApiOperation({
    operationId: 'getCustomerProfile',
    summary: 'The signed-in customer',
    description: 'A 401 means nobody is signed in (`getProfile` → null).',
  })
  @ApiResponse({ status: 200, type: CustomerProfileResponse })
  @ApiResponse({
    status: 401,
    description: 'No valid customer token, or the account is gone.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'A staff token.',
    type: ApiErrorResponse,
  })
  me(
    @CurrentCustomer() customer: CustomerPrincipal,
  ): Promise<CustomerProfileResponse> {
    return this.customers.profile(customer.id);
  }

  @Patch()
  @ApiOperation({
    operationId: 'updateCustomerProfile',
    summary: 'Change your profile',
    description:
      'Each field changes only when sent. Today: `name` (the first-time ' +
      'name step). Returns the whole profile.',
  })
  @ApiResponse({ status: 200, type: CustomerProfileResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Add your name." for a blank name; "Keep your name to 80 ' +
      'characters."; or a field this route does not take.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'No valid customer token, or the account is gone.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description: 'A staff token.',
    type: ApiErrorResponse,
  })
  update(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Body() request: UpdateMeRequest,
  ): Promise<CustomerProfileResponse> {
    return this.customers.update(customer.id, request);
  }
}
