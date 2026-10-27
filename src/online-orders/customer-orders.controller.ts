import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { CustomerPrincipal } from '../auth/customer-principal';
import { CurrentCustomer } from '../auth/decorators/current-customer.decorator';
import { CncCustomerGuard } from '../auth/guards/cnc-customer.guard';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { PaginationQuery } from '../common/dto/pagination.query';
import { CustomerOrdersService } from './customer-orders.service';
import {
  CustomerOrderPageResponse,
  CustomerOrderResponse,
} from './dto/customer-order.response';

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

/**
 * The signed-in customer's web orders (plan §5.2, card C7-6): the account
 * app's order list and the tracker, on the stored status. Personal data:
 * never stored by a cache.
 */
@ApiTags('Customer account')
@ApiBearerAuth()
@UseGuards(CncCustomerGuard)
@Controller('me/orders')
export class CustomerOrdersController {
  constructor(private readonly orders: CustomerOrdersService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'myOrders',
    summary: 'My orders',
    description:
      'The web orders linked to this account, newest first, each as it ' +
      'now stands: the stored stage, the lines and the money.',
  })
  @ApiResponse({ status: 200, type: CustomerOrderPageResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  list(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Query() query: PaginationQuery,
  ): Promise<CustomerOrderPageResponse> {
    return this.orders.list(customer.id, query);
  }

  @Get(':number')
  @Header('Cache-Control', 'no-store')
  @ApiParam({
    name: 'number',
    description: 'The order number (`CNCR-000124`).',
  })
  @ApiOperation({
    operationId: 'myOrder',
    summary: 'One of my orders (the tracker)',
    description:
      'Polled by the tracker every 30 seconds; the stage is the one staff ' +
      'stored, never one guessed from the clock.',
  })
  @ApiResponse({ status: 200, type: CustomerOrderResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(STAFF_TOKEN)
  @ApiResponse({
    status: 404,
    description:
      '"We could not find that order on this account." (also for another ' +
      'customer’s).',
    type: ApiErrorResponse,
  })
  one(
    @CurrentCustomer() customer: CustomerPrincipal,
    @Param('number') number: string,
  ): Promise<CustomerOrderResponse> {
    return this.orders.one(customer.id, number);
  }
}
