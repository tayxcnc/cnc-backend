import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { PasswordChangeExempt } from '../auth/decorators/password-change-exempt.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { OverviewPreferencesDto } from './dto/overview-preferences.dto';
import { ReferenceResponse } from './dto/reference.response';
import { StaffMeResponse } from './dto/staff-me.response';
import type { OverviewPreferences } from './overview-preferences';
import { ShellService } from './shell.service';

const UNAUTHORISED = {
  status: 401,
  description: 'No bearer token, or one that fails verification.',
  type: ApiErrorResponse,
} as const;

const REFUSED = {
  status: 403,
  description:
    'A customer token, a deactivated account, or (except on GET ' +
    '/staff/me) a pending password change.',
  type: ApiErrorResponse,
} as const;

/**
 * The staff app's shell (plan §5.3; card C3-8). Every active staff member,
 * whatever their role.
 */
@ApiTags('Staff shell')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff')
export class ShellController {
  constructor(private readonly shell: ShellService) {}

  @Get('me')
  @PasswordChangeExempt()
  @ApiOperation({
    operationId: 'staffMe',
    summary: 'Who is signed in',
    description:
      'The account, the screens its role may open, and whether it must ' +
      'change its password. Answered during a forced password change, so ' +
      'a reloading app knows to show that screen.',
  })
  @ApiResponse({ status: 200, type: StaffMeResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  me(@CurrentStaff() actor: StaffPrincipal): Promise<StaffMeResponse> {
    return this.shell.me(actor);
  }

  @Get('reference')
  @ApiOperation({
    operationId: 'staffReference',
    summary: 'Reference data for every screen',
    description:
      'Settings, business details, opening hours, rooms and tables, menu ' +
      'categories, the menu, stock items and colleagues, read together.',
  })
  @ApiResponse({ status: 200, type: ReferenceResponse })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  reference(): Promise<ReferenceResponse> {
    return this.shell.reference();
  }

  @Get('me/preferences/overview')
  @ApiOperation({
    operationId: 'staffOverviewPreferences',
    summary: 'My overview layout',
    description:
      'The stored layout made whole, or the Service preset for today when ' +
      'none is stored.',
  })
  @ApiResponse({ status: 200, type: OverviewPreferencesDto })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  overviewPreferences(
    @CurrentStaff() actor: StaffPrincipal,
  ): Promise<OverviewPreferences> {
    return this.shell.overviewPreferences(actor);
  }

  @Put('me/preferences/overview')
  @ApiOperation({
    operationId: 'staffOverviewPreferencesSave',
    summary: 'Save my overview layout',
    description:
      'Replaces the layout. Widgets left out are added hidden. The last ' +
      'save wins: the layout is the person’s own, not a shared record.',
  })
  @ApiResponse({ status: 200, type: OverviewPreferencesDto })
  @ApiResponse({
    status: 400,
    description:
      'An unknown widget or period, a repeated widget, nothing shown, or a ' +
      'date that is not a real YYYY-MM-DD day.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(REFUSED)
  saveOverviewPreferences(
    @CurrentStaff() actor: StaffPrincipal,
    @Body() request: OverviewPreferencesDto,
  ): Promise<OverviewPreferences> {
    return this.shell.saveOverviewPreferences(actor, request);
  }
}
