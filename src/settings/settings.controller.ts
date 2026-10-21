import {
  Body,
  Controller,
  Get,
  Patch,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
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
import {
  OpeningHoursResponse,
  ReplaceOpeningHoursRequest,
} from './dto/opening-hours.dto';
import { SettingsPageResponse } from './dto/settings-page.response';
import { BusinessResponse, SettingsResponse } from './dto/settings.response';
import { UpdateBusinessRequest } from './dto/update-business.request';
import { UpdateSettingsRequest } from './dto/update-settings.request';
import { OpeningHoursService } from './opening-hours.service';
import { SettingsService } from './settings.service';

const UNAUTHORISED = {
  status: 401,
  description: 'No bearer token, or one that fails verification.',
  type: ApiErrorResponse,
} as const;

const STALE = {
  status: 409,
  description: '"This record changed. Refresh and try again."',
  type: ApiErrorResponse,
} as const;

/**
 * Settings (plan §5.4; card C3-7): the settings row, the business details
 * and the week's opening hours. Every route is for managers; the Owner-only
 * keys and the hours are refused to a Manager inside the commands
 * (`MoneyControlService.requireOwner`), with the demo's sentence or Q29's.
 */
@ApiTags('Settings')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Roles()
@Controller('staff')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly hours: OpeningHoursService,
  ) {}

  @Get('settings')
  @ApiOperation({
    operationId: 'staffSettingsRead',
    summary: 'The settings, business details and opening hours',
    description: 'Managers only. Each part carries the version its save needs.',
  })
  @ApiResponse({ status: 200, type: SettingsPageResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description: 'Not a manager, or the caller may not use staff routes.',
    type: ApiErrorResponse,
  })
  async read(): Promise<SettingsPageResponse> {
    return {
      settings: await this.settings.readSettings(),
      business: await this.settings.readBusiness(),
      openingHours: await this.hours.read(),
    };
  }

  @Patch('settings')
  @ApiOperation({
    operationId: 'staffSettingsSave',
    summary: 'Save settings (settings.save)',
    description:
      'Managers only. Send only what changes. VAT, service charge, the ' +
      'deposit, both delivery fees, the approval limit and the daily limit ' +
      'and its switch are the Owner’s; so are the six booking and ordering ' +
      'times (Q29). A manager may send one of those keys unchanged.',
  })
  @ApiResponse({ status: 200, type: SettingsResponse })
  @ApiResponse({
    status: 400,
    description:
      'A value out of range, with the demo’s sentence ("Settings must be ' +
      'non-negative numbers.", "Check tax, service charge or the free ' +
      'table reminder (15 to 1440 minutes).", "Choose a printer paper ' +
      'width.", "Daily limit must be on or off.").',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      'Not a manager; a Manager changing an Owner-only key ("Only the Owner ' +
      'can change tax, service charge, delivery fees or the approval ' +
      'limits.") or a time ("Only the Owner can change the opening hours ' +
      'or the booking and ordering times.").',
    type: ApiErrorResponse,
  })
  @ApiResponse(STALE)
  save(
    @CurrentStaff() actor: StaffPrincipal,
    @Body() request: UpdateSettingsRequest,
    @Req() httpRequest: Request,
  ): Promise<SettingsResponse> {
    return this.settings.save(actor, request, clientAddressOf(httpRequest));
  }

  @Patch('business')
  @ApiOperation({
    operationId: 'staffBusinessSave',
    summary: 'Save the business details (settings.save)',
    description:
      'Managers only. Send only what changes; the name, the address and ' +
      'the phone may never be blank. Shown on the website, receipts and ' +
      'the entrance.',
  })
  @ApiResponse({ status: 200, type: BusinessResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Business name, address and phone are required for receipts.", ' +
      '"Enter a valid business email.", or another bad field.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description: 'Not a manager, or the caller may not use staff routes.',
    type: ApiErrorResponse,
  })
  @ApiResponse(STALE)
  saveBusiness(
    @CurrentStaff() actor: StaffPrincipal,
    @Body() request: UpdateBusinessRequest,
    @Req() httpRequest: Request,
  ): Promise<BusinessResponse> {
    return this.settings.saveBusiness(
      actor,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Put('opening-hours')
  @ApiOperation({
    operationId: 'staffOpeningHoursReplace',
    summary: 'Replace the week’s opening hours',
    description:
      'The Owner only (Q29). All seven days, replacing the stored week in ' +
      'one transaction. Each day is closed (no times) or open with ' +
      '`opensAtMinutes` < `closesAtMinutes` <= 1440, in WAT minutes from ' +
      'midnight. Two saves at once are applied one after the other.',
  })
  @ApiResponse({ status: 200, type: OpeningHoursResponse })
  @ApiResponse({
    status: 400,
    description:
      'Not the seven days once each; a closed day with a time; an open day ' +
      'missing one; a day closing at or before it opens.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      'Not a manager; or a Manager ("Only the Owner can change the opening ' +
      'hours or the booking and ordering times.").',
    type: ApiErrorResponse,
  })
  replaceOpeningHours(
    @CurrentStaff() actor: StaffPrincipal,
    @Body() request: ReplaceOpeningHoursRequest,
    @Req() httpRequest: Request,
  ): Promise<OpeningHoursResponse> {
    return this.hours.replace(actor, request, clientAddressOf(httpRequest));
  }
}
