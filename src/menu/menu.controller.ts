import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
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
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { VersionedWriteDto } from '../common/dto/versioned-write.dto';
import {
  IdempotencyKey,
  type IdempotencyRequest,
  IdempotentRoute,
} from '../idempotency/idempotency-key.decorator';
import { idempotencyScope } from '../idempotency/idempotency-scope';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { PhotoUpload, PhotoUploadRequest } from '../images/photo-upload';
import type { UploadedImageFile } from '../images/uploaded-image';
import {
  CreateMenuItemRequest,
  UpdateMenuItemRequest,
} from './dto/menu-item.request';
import {
  MenuItemResponse,
  MenuListQuery,
  MenuPageResponse,
} from './dto/menu-item.response';
import { MenuService, rethrowStockNameClash } from './menu.service';

const UNAUTHORISED = {
  status: 401,
  description: 'No bearer token, or one that fails verification.',
  type: ApiErrorResponse,
} as const;

const NOT_A_MANAGER = {
  status: 403,
  description: 'Not a manager, or the caller may not use staff routes.',
  type: ApiErrorResponse,
} as const;

const NOT_FOUND = {
  status: 404,
  description: '"Menu item not found."',
  type: ApiErrorResponse,
} as const;

const STALE = {
  status: 409,
  description: '"This record changed. Refresh and try again."',
  type: ApiErrorResponse,
} as const;

const ID_PARAM = { name: 'id', description: 'MenuItem.id.' } as const;

/**
 * Menu & Prices (plan §5.4; card C3-7). Managers only; adding an item and
 * changing a price are the Owner's.
 */
@ApiTags('Menu & Prices')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Roles()
@Controller('staff/menu')
export class MenuController {
  constructor(
    private readonly menu: MenuService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'staffMenuList',
    summary: 'Menu items, in menu order',
    description:
      'Managers only. Every item, available or not, shown online or not. ' +
      'Photos as short-lived signed links.',
  })
  @ApiResponse({ status: 200, type: MenuPageResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad filter or page.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(NOT_A_MANAGER)
  list(@Query() query: MenuListQuery): Promise<MenuPageResponse> {
    return this.menu.list(query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffMenuCreate',
    summary: 'Add a menu item (menu.save)',
    description:
      'The Owner only. Takes an Idempotency-Key, so a retry after a lost ' +
      'response returns the first item instead of adding a second. The ' +
      'slug is made from the name and never reused; the customer category ' +
      'follows the staff category. A Bar item gets its paired Bar stock ' +
      'item (a serving, bought in batches of 12, reorder level 12) in the ' +
      'same transaction.',
  })
  @ApiResponse({ status: 201, type: MenuItemResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter an item name and positive price.", "Choose a department.", ' +
      '"Choose a category from the item\'s department.", or a missing ' +
      'Idempotency-Key.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      'Not a manager; or a Manager ("Only the Owner can add a menu item, ' +
      'because every item needs a price.").',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description:
      'A Bar item whose name a stock item already holds ("This stock item ' +
      'already exists."), or the key was used for a different request.',
    type: ApiErrorResponse,
  })
  async create(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: CreateMenuItemRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MenuItemResponse> {
    this.menu.assertMayCreate(actor);

    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency
      .execute({
        ...idempotency,
        scope: idempotencyScope.staff(actor.id),
        status: HttpStatus.CREATED,
        work: (tx) => this.menu.create(tx, actor, request, ipAddress),
      })
      .catch(rethrowStockNameClash);

    response.status(result.status);

    return result.body;
  }

  @Patch(':id')
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffMenuUpdate',
    summary: 'Change a menu item (menu.save)',
    description:
      'Managers only; a price change is the Owner’s. Send only what ' +
      'changes, or the whole form: a price sent unchanged is allowed. The ' +
      'department and the slug never change.',
  })
  @ApiResponse({ status: 200, type: MenuItemResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter an item name and positive price.", "Choose a category from ' +
      'the item\'s department.", or another bad field.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      'Not a manager; or a Manager changing the price ("Only the Owner can ' +
      'change a price.").',
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(STALE)
  update(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: UpdateMenuItemRequest,
    @Req() httpRequest: Request,
  ): Promise<MenuItemResponse> {
    return this.menu.update(actor, id, request, clientAddressOf(httpRequest));
  }

  @Post(':id/photo')
  @HttpCode(HttpStatus.OK)
  @PhotoUpload()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffMenuReplacePhoto',
    summary: 'Replace a menu photo',
    description:
      'Managers only. Multipart: the file in `photo`, the item’s `version` ' +
      'beside it. Judged by its bytes, fitted inside 800 pixels with every ' +
      'piece of metadata removed, and stored privately; the response ' +
      'carries a short-lived signed link.',
  })
  @ApiResponse({ status: 200, type: MenuItemResponse })
  @ApiResponse({
    status: 400,
    description: 'No file, a bad version, or an image too large to decode.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(NOT_A_MANAGER)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(STALE)
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
  replacePhoto(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: PhotoUploadRequest,
    @UploadedFile() photo: UploadedImageFile | undefined,
    @Req() httpRequest: Request,
  ): Promise<MenuItemResponse> {
    return this.menu.replacePhoto(
      actor,
      id,
      request.version,
      photo,
      clientAddressOf(httpRequest),
    );
  }

  @Delete(':id/photo')
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffMenuRemovePhoto',
    summary: 'Remove a menu photo',
    description: 'Managers only.',
  })
  @ApiResponse({ status: 200, type: MenuItemResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(NOT_A_MANAGER)
  @ApiResponse(NOT_FOUND)
  @ApiResponse(STALE)
  removePhoto(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: VersionedWriteDto,
    @Req() httpRequest: Request,
  ): Promise<MenuItemResponse> {
    return this.menu.removePhoto(
      actor,
      id,
      request.version,
      clientAddressOf(httpRequest),
    );
  }
}
