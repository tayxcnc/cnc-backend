import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
import { AssetsService } from './assets.service';
import {
  AssetsQuery,
  CreateRepairRequest,
  RepairsQuery,
  SaveAssetRequest,
  UpdateRepairRequest,
} from './dto/assets.request';
import {
  AssetPageResponse,
  AssetResponse,
  RepairPageResponse,
  RepairResponse,
} from './dto/assets.response';
import { MaintenanceService } from './maintenance.service';

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

const REPAIR_REFUSED = {
  status: 400,
  description:
    '"Select an asset and vendor.", "Enter a description and valid cost.", ' +
    '"Invalid repair status.", "Choose a maintenance or general task.", or ' +
    'a bad reason.',
  type: ApiErrorResponse,
} as const;

const STALE = '"This record changed. Refresh and try again."';

/**
 * Assets & Maintenance (plan §5.4; card C5-6): the venue's assets, which
 * managers keep, and their repairs, which Reception logs and follows.
 * Reactive only (Q13's default).
 */
@ApiTags('Assets & Maintenance')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff')
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly repairs: MaintenanceService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('assets')
  @Roles(StaffRole.RECEPTION)
  @ApiOperation({
    operationId: 'staffAssets',
    summary: 'Assets, by tag',
    description:
      'Reception reads them to log a repair; managers also edit them.',
  })
  @ApiResponse({ status: 200, type: AssetPageResponse })
  @ApiResponse({
    status: 400,
    description: '"Choose an asset status.", or a bad page or search.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  listAssets(@Query() query: AssetsQuery): Promise<AssetPageResponse> {
    return this.assets.list(query);
  }

  @Put('assets/:tag')
  @Roles()
  @ApiParam({ name: 'tag', description: 'Asset.tag: `AC1`.' })
  @ApiOperation({
    operationId: 'staffAssetSave',
    summary: 'Add or change an asset (asset.save)',
    description:
      'Managers. With no `version`, adds the asset under the tag (201); ' +
      'with one, replaces the asset the tag names (200). Its status changes ' +
      'only when one is sent.',
  })
  @ApiResponse({ status: 200, type: AssetResponse })
  @ApiResponse({ status: 201, type: AssetResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter a tag, name and quantity.", "Choose an asset status.", or a ' +
      'bad category, location or version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 404,
    description: '"Asset not found." (an update naming an unknown tag)',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description: `"This asset tag already exists." (a new asset), or ${STALE}`,
    type: ApiErrorResponse,
  })
  async saveAsset(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('tag') tag: string,
    @Body() request: SaveAssetRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AssetResponse> {
    const saved = await this.assets.save(
      actor,
      tag,
      request,
      clientAddressOf(httpRequest),
    );

    response.status(saved.created ? HttpStatus.CREATED : HttpStatus.OK);

    return saved.asset;
  }

  @Get('maintenance')
  @Roles(StaffRole.RECEPTION)
  @ApiOperation({
    operationId: 'staffRepairs',
    summary: 'Repairs, newest first',
    description:
      'Each with its asset, vendor, status history and the tasks that ' +
      'track it.',
  })
  @ApiResponse({ status: 200, type: RepairPageResponse })
  @ApiResponse({
    status: 400,
    description: '"Choose a repair status.", or a bad page or search.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  listRepairs(@Query() query: RepairsQuery): Promise<RepairPageResponse> {
    return this.repairs.list(query);
  }

  @Post('maintenance')
  @Roles(StaffRole.RECEPTION)
  @HttpCode(HttpStatus.CREATED)
  @IdempotentRoute()
  @ApiOperation({
    operationId: 'staffRepairCreate',
    summary: 'Log a repair (maintenance.save)',
    description:
      'Reception and managers. The asset goes Under Repair (or Active or ' +
      'Inactive, for a repair logged already Fixed or Not Fixed). A manager ' +
      'gets a follow-up task, unless `taskId` names the task this repair ' +
      'is for. Takes an Idempotency-Key, so a retry after a lost response ' +
      'does not log it twice.',
  })
  @ApiResponse({ status: 201, type: RepairResponse })
  @ApiResponse(REPAIR_REFUSED)
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 404,
    description: '"Task not found."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description:
      '"This task already has a maintenance record.", or the ' +
      'Idempotency-Key was used for a different request.',
    type: ApiErrorResponse,
  })
  async createRepair(
    @CurrentStaff() actor: StaffPrincipal,
    @IdempotencyKey() idempotency: IdempotencyRequest,
    @Body() request: CreateRepairRequest,
    @Req() httpRequest: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RepairResponse> {
    const ipAddress = clientAddressOf(httpRequest);
    const result = await this.idempotency.execute({
      ...idempotency,
      scope: idempotencyScope.staff(actor.id),
      status: HttpStatus.CREATED,
      work: (tx) => this.repairs.create(tx, actor, request, ipAddress),
    });

    response.status(result.status);

    return result.body;
  }

  @Patch('maintenance/:id')
  @Roles(StaffRole.RECEPTION)
  @ApiParam({ name: 'id', description: 'MaintenanceRecord.id.' })
  @ApiOperation({
    operationId: 'staffRepairUpdate',
    summary: 'Update a repair (maintenance.save)',
    description:
      'Reception and managers. The first move to Fixed or Not Fixed sets ' +
      'the resolved date, which is then kept (R3), and closes the open ' +
      'tasks on the repair.',
  })
  @ApiResponse({ status: 200, type: RepairResponse })
  @ApiResponse(REPAIR_REFUSED)
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 404,
    description: '"Maintenance record not found.", or "Task not found."',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description: `"This task already has a maintenance record.", or ${STALE}`,
    type: ApiErrorResponse,
  })
  updateRepair(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: UpdateRepairRequest,
    @Req() httpRequest: Request,
  ): Promise<RepairResponse> {
    return this.repairs.update(
      actor,
      id,
      request,
      clientAddressOf(httpRequest),
    );
  }
}
