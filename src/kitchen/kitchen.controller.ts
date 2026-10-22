import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
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
import { StaffRole } from '../../generated/cnc-client';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import {
  KitchenEntriesQuery,
  SaveKitchenEntryRequest,
} from './dto/kitchen.request';
import {
  KitchenDayResponse,
  KitchenEntryPageResponse,
  KitchenEntryResponse,
} from './dto/kitchen.response';
import { KitchenService } from './kitchen.service';

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

const DATE_PARAM = {
  name: 'date',
  description: 'The kitchen date (YYYY-MM-DD).',
  example: '2026-10-21',
} as const;

/**
 * The Kitchen screen (plan §5.4, §6.2; card C4-6): the day's kitchen
 * entries, recording or correcting the portions for a docket, and closing
 * the kitchen day. The Kitchen and managers; the docket reads are
 * `GET /staff/dockets` and the Kitchen balances `GET /staff/stock/balances`.
 */
@ApiTags('Kitchen')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Roles(StaffRole.KITCHEN)
@Controller('staff/kitchen')
export class KitchenController {
  constructor(private readonly kitchen: KitchenService) {}

  @Get('entries')
  @ApiOperation({
    operationId: 'staffKitchenEntries',
    summary: 'One kitchen date’s entries',
    description:
      'Entries for the date (today when absent), in the order they were ' +
      'first recorded, optionally filtered by docket or order number, with ' +
      'the portions recorded across every match.',
  })
  @ApiResponse({ status: 200, type: KitchenEntryPageResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad date, search or page.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  entries(
    @Query() query: KitchenEntriesQuery,
  ): Promise<KitchenEntryPageResponse> {
    return this.kitchen.list(query);
  }

  @Put('entries/:docketRef')
  @ApiParam({
    name: 'docketRef',
    description: 'The docket number as printed (`KOT-CNCR-000001`), any case.',
  })
  @ApiOperation({
    operationId: 'staffKitchenSave',
    summary: 'Record or correct a docket’s portions (kitchen.save)',
    description:
      'Without `version`, the docket’s first entry; with it, a correction ' +
      'of the existing entry. The order, revision and date come from the ' +
      'docket’s latest revision. Kitchen stock moves by the difference. ' +
      'An entry for another date, a closed day, or an earlier day’s entry ' +
      'is a manager’s correction with a reason. No Idempotency-Key: a ' +
      'retried first entry is refused as a duplicate, and a retried ' +
      'correction names a version the first attempt moved.',
  })
  @ApiResponse({ status: 200, type: KitchenEntryResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter kitchen portions.", "Add at least one item.", "Combine ' +
      'duplicate items into one quantity.", "Quantities must be whole ' +
      'numbers above zero.", "Select a kitchen portion.", "Enter a valid ' +
      'kitchen date.", "A kitchen entry cannot be dated in the future.", ' +
      '"Kitchen date is assigned by the system.", "Docket revision is ' +
      'assigned by the system.", "Restaurant order is assigned by the ' +
      'system.", "An admin correction requires a reason.", or a bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      '"Your current staff role cannot perform this action.": not Kitchen ' +
      'or a manager, or a correction by the Kitchen.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description:
      '"Docket not found. Enter the kitchen docket number printed by ' +
      'Restaurant POS.", or "Kitchen entry not found." for a version with ' +
      'no entry.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description:
      '"This docket already exists. Edit its existing kitchen entry.", ' +
      '"Insufficient kitchen stock for Rice.", or "This record changed. ' +
      'Refresh and try again."',
    type: ApiErrorResponse,
  })
  save(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('docketRef') docketRef: string,
    @Body() request: SaveKitchenEntryRequest,
    @Req() httpRequest: Request,
  ): Promise<KitchenEntryResponse> {
    return this.kitchen.save(
      actor,
      docketRef,
      request,
      clientAddressOf(httpRequest),
    );
  }

  @Get('days/:date')
  @ApiParam(DATE_PARAM)
  @ApiOperation({
    operationId: 'staffKitchenDay',
    summary: 'Whether a kitchen day is closed',
    description:
      '`locked` is true for any day but an open today: entries for it are ' +
      'managers’ corrections with a reason.',
  })
  @ApiResponse({ status: 200, type: KitchenDayResponse })
  @ApiResponse({
    status: 400,
    description: 'A date that is not a real calendar date.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  day(@Param('date') date: string): Promise<KitchenDayResponse> {
    return this.kitchen.day(date);
  }

  @Post('days/:date/close')
  @HttpCode(HttpStatus.OK)
  @ApiParam(DATE_PARAM)
  @ApiOperation({
    operationId: 'staffKitchenClose',
    summary: 'Close today’s kitchen day (kitchen.close)',
    description:
      'Today in Lagos only, once. Saved entries lock: corrections then ' +
      'need a manager and a reason. Guest bills stay payable.',
  })
  @ApiResponse({ status: 200, type: KitchenDayResponse })
  @ApiResponse({
    status: 400,
    description: '"Only the current kitchen day can be closed."',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse(ROLE_REFUSED)
  @ApiResponse({
    status: 409,
    description: '"This kitchen day is already closed."',
    type: ApiErrorResponse,
  })
  close(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('date') date: string,
    @Req() httpRequest: Request,
  ): Promise<KitchenDayResponse> {
    return this.kitchen.close(actor, date, clientAddressOf(httpRequest));
  }
}
