import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { StaffRole } from '../../generated/cnc-client';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import {
  IdempotencyKey,
  type IdempotencyRequest,
  IdempotentRoute,
} from '../idempotency/idempotency-key.decorator';
import { idempotencyScope } from '../idempotency/idempotency-scope';
import { IdempotencyService } from '../idempotency/idempotency.service';
import {
  CreateVendorRequest,
  UpdateVendorRequest,
  VendorPageResponse,
  VendorResponse,
  VendorsQuery,
} from './dto/vendors.dto';
import { VendorsService } from './vendors.service';

const UNAUTHORISED = {
  status: 401,
  description: 'No bearer token, or one that fails verification.',
  type: ApiErrorResponse,
} as const;

const ROLE_REFUSED = {
  status: 403,
  description: '"Your current staff role cannot perform this action."',
  type: ApiErrorResponse,
} as const;

const BAD_PROFILE = {
  status: 400,
  description:
    '"Enter the vendor name and phone.", or a field that is too long or ' +
    'not text.',
  type: ApiErrorResponse,
} as const;

/**
 * Vendors (plan §5.4; card C5-3): the Storekeeper's and the managers'
 * supplier list and `vendor.save`. Every other screen names vendors from
 * the lite list on `GET /staff/reference`.
 */
@ApiTags('Vendors')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/vendors')
export class VendorsController {
  constructor(
    private readonly vendors: VendorsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Roles(StaffRole.STOREKEEPER)
  @ApiOperation({
    operationId: 'staffVendors',
    summary: 'Vendors, by name',
    description: 'Active and inactive, with every contact field.',
  })
  @ApiResponse({ status: 200, type: VendorPageResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad page or search.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  list(@Query() query: VendorsQuery): Promise<VendorPageResponse> {
    return this.vendors.list(query);
  }

  @Post()
  @Roles(StaffRole.STOREKEEPER)
  @HttpCode(HttpStatus.CREATED)
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffVendorCreate',
    summary: 'Add a vendor (vendor.save)',
    description:
      'The Storekeeper and managers. Takes an Idempotency-Key, so a retry ' +
      'after a lost response does not add the vendor twice.',
  })
  @ApiResponse({ status: 201, type: VendorResponse })
  @ApiResponse(BAD_PROFILE)
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 409,
    description: 'The Idempotency-Key was used for a different request.',
    type: ApiErrorResponse,
  })
  async create(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: CreateVendorRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VendorResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.vendors.create(tx, actor, request, ipAddress),
    });

    response.status(result.status);

    return result.body;
  }

  @Patch(':id')
  @Roles(StaffRole.STOREKEEPER)
  @ApiParam({ name: 'id', description: 'Vendor.id.' })
  @ApiOperation({
    operationId: 'staffVendorUpdate',
    summary: 'Change a vendor (vendor.save)',
    description:
      'The whole profile, as the form sends it. The status changes only ' +
      'when `isActive` is sent.',
  })
  @ApiResponse({ status: 200, type: VendorResponse })
  @ApiResponse(BAD_PROFILE)
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 404,
    description: '"Vendor not found."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description: '"This record changed. Refresh and try again."',
    type: ApiErrorResponse,
  })
  update(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: UpdateVendorRequest,
    @Req() httpRequest: Request,
  ): Promise<VendorResponse> {
    return this.vendors.update(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }
}
