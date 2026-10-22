import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { PublicCache } from '../common/public-cache';
import {
  OrderingConfigResponse,
  OrderingSlotsQuery,
  OrderingSlotsResponse,
} from './dto/ordering.dto';
import { OrderingService } from './ordering.service';

/**
 * The order page's public reads (plan §5.1, C6-4). No sign-in. The config
 * is cached for a minute; the slots depend on the minute they are asked,
 * so they are never stored.
 */
@ApiTags('Public')
@Controller('ordering')
export class OrderingController {
  constructor(private readonly ordering: OrderingService) {}

  @Get('config')
  @PublicCache()
  @ApiOperation({
    operationId: 'getOrderingConfig',
    summary: 'Prices and times the order page uses',
    description:
      'VAT, the two delivery zones with their fees and lead times, the ' +
      'pickup lead time, the slot grid and the last order slot. Public; ' +
      'cached for a minute.',
  })
  @ApiResponse({ status: 200, type: OrderingConfigResponse })
  config(): Promise<OrderingConfigResponse> {
    return this.ordering.config();
  }

  @Get('slots')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'getOrderingSlots',
    summary: 'When an order placed now can be received',
    description:
      'Whether "As soon as possible" is offered, and the scheduled times ' +
      'left today and tomorrow (Lagos time), for the fulfilment and zone ' +
      'given. Public; never cached.',
  })
  @ApiResponse({ status: 200, type: OrderingSlotsResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose delivery or pickup." or, for a delivery, "Choose where we ' +
      'are delivering to."',
    type: ApiErrorResponse,
  })
  slots(@Query() query: OrderingSlotsQuery): Promise<OrderingSlotsResponse> {
    return this.ordering.slots(query);
  }
}
