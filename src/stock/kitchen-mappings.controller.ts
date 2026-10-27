import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { PaginationQuery } from '../common/dto/pagination.query';
import {
  KitchenMappingPageResponse,
  KitchenMappingResponse,
  SaveKitchenMappingRequest,
} from './dto/kitchen-mapping.dto';
import { KitchenMappingService } from './kitchen-mapping.service';

const UNAUTHORISED = {
  status: 401,
  description: 'No bearer token, or one that fails verification.',
  type: ApiErrorResponse,
} as const;

const NOT_A_MANAGER = {
  status: 403,
  description:
    'Not a manager ("Your current staff role cannot perform this action.").',
  type: ApiErrorResponse,
} as const;

/**
 * Settings → Kitchen Comparison Rules (plan §5.4; card C4-2). Managers only.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Roles()
@Controller('staff/kitchen-mappings')
export class KitchenMappingsController {
  constructor(private readonly mappings: KitchenMappingService) {}

  @Get()
  @ApiOperation({
    operationId: 'staffKitchenMappings',
    summary: 'Kitchen comparison rules',
    description:
      'The Restaurant dishes that have a rule, by name, each with its ' +
      'expected Kitchen portions.',
  })
  @ApiResponse({ status: 200, type: KitchenMappingPageResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad page.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(NOT_A_MANAGER)
  list(@Query() query: PaginationQuery): Promise<KitchenMappingPageResponse> {
    return this.mappings.list(query);
  }

  @Put(':menuItemId')
  @ApiParam({
    name: 'menuItemId',
    description: 'MenuItem.id of a Restaurant dish.',
  })
  @ApiOperation({
    operationId: 'staffKitchenMappingSave',
    summary: 'Add or replace a dish’s rule (mapping.save)',
    description:
      'Replaces the dish’s whole rule. Never fills in a kitchen entry or ' +
      'moves stock.',
  })
  @ApiResponse({ status: 200, type: KitchenMappingResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Choose a food menu item.", "Add at least one item.", "Combine ' +
      'duplicate items into one quantity.", "Quantities must be whole ' +
      'numbers above zero." or "Choose a kitchen portion."',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(NOT_A_MANAGER)
  save(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('menuItemId') menuItemId: string,
    @Body() request: SaveKitchenMappingRequest,
    @Req() httpRequest: Request,
  ): Promise<KitchenMappingResponse> {
    return this.mappings.save(
      actor,
      menuItemId,
      request,
      clientAddressOf(httpRequest),
    );
  }
}
