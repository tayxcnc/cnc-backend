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
import type { Request } from 'express';
import { CurrentStaff } from '../auth/decorators/current-staff.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CncStaffGuard } from '../auth/guards/cnc-staff.guard';
import type { StaffPrincipal } from '../auth/staff-principal';
import { clientAddressOf } from '../common/client-address';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { VersionedWriteDto } from '../common/dto/versioned-write.dto';
import { PhotoUpload, PhotoUploadRequest } from '../images/photo-upload';
import type { UploadedImageFile } from '../images/uploaded-image';
import { CreateStaffRequest } from './dto/create-staff.request';
import { StaffListQuery } from './dto/staff-list.query';
import {
  StaffCreatedResponse,
  StaffPageResponse,
  StaffPersonResponse,
} from './dto/staff-person.response';
import { UpdateStaffRequest } from './dto/update-staff.request';
import { StaffPeopleService } from './staff-people.service';

const UNAUTHORISED = {
  status: 401,
  description: 'No bearer token, or one that fails verification.',
  type: ApiErrorResponse,
} as const;

const STALE_OR_TAKEN = {
  status: 409,
  description:
    'The account changed since it was read ("This record changed. Refresh ' +
    'and try again."), or the email belongs to another account.',
  type: ApiErrorResponse,
} as const;

const NOT_FOUND = {
  status: 404,
  description: '"Staff account not found."',
  type: ApiErrorResponse,
} as const;

const ID_PARAM = {
  name: 'id',
  description: 'Staff.id of the account.',
} as const;

/**
 * Staff & Access (plan §5.4; card C3-6): the account list, `staff.save`,
 * `staff.photo` and the staff ID reissue. Managers only, except a person's
 * own photograph. The admin password reset is under the same prefix in
 * `StaffPasswordResetController` (C3-3).
 */
@ApiTags('Staff & Access')
@ApiBearerAuth()
@UseGuards(CncStaffGuard)
@Controller('staff/people')
export class StaffPeopleController {
  constructor(private readonly people: StaffPeopleService) {}

  @Get()
  @Roles()
  @ApiOperation({
    operationId: 'staffPeopleList',
    summary: 'Staff accounts, by name',
    description:
      'Managers only. Never a password hash or a QR token; photos as ' +
      'short-lived signed links.',
  })
  @ApiResponse({ status: 200, type: StaffPageResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad page.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description: 'Not a manager, or the caller may not use staff routes.',
    type: ApiErrorResponse,
  })
  list(@Query() query: StaffListQuery): Promise<StaffPageResponse> {
    return this.people.list(query);
  }

  @Post()
  @Roles()
  @ApiOperation({
    operationId: 'staffPeopleCreate',
    summary: 'Create a staff account (staff.save)',
    description:
      'Managers only; only the Owner may create a Manager or Owner. The ' +
      'account gets the next staff number, a QR staff ID and a temporary ' +
      'password, returned once in this response, which the person must ' +
      'replace at first sign-in. A lost one is replaced with the admin ' +
      'reset. No Idempotency-Key: the response carries a password that is ' +
      'never stored, so it could not be replayed, and a repeated request ' +
      'is refused on the email.',
  })
  @ApiResponse({ status: 201, type: StaffCreatedResponse })
  @ApiResponse({
    status: 400,
    description:
      '"Enter a staff name and role." or "Enter a valid sign-in email."',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      'Not a manager; or a Manager creating a Manager or Owner ("Only the ' +
      'Owner can create or change Manager and Owner accounts.").',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description: '"This sign-in email already belongs to another account."',
    type: ApiErrorResponse,
  })
  create(
    @CurrentStaff() actor: StaffPrincipal,
    @Body() request: CreateStaffRequest,
    @Req() httpRequest: Request,
  ): Promise<StaffCreatedResponse> {
    return this.people.create(actor, request, clientAddressOf(httpRequest));
  }

  @Patch(':id')
  @Roles()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffPeopleUpdate',
    summary: 'Change a staff account (staff.save)',
    description:
      'Managers only; only the Owner may change a Manager or Owner account ' +
      'or make one. Fields left out are unchanged; the status changes only ' +
      'when `isActive` is sent. A name or email change needs a `reason`. A ' +
      'change of role, email or status ends every session the account ' +
      'holds. The last active Owner cannot be demoted or deactivated.',
  })
  @ApiResponse({ status: 200, type: StaffPersonResponse })
  @ApiResponse({
    status: 400,
    description:
      'A bad field, or a name or email change without a reason ("Record a ' +
      'reason for …").',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description:
      'Not a manager; a Manager changing a Manager or Owner account; or ' +
      '"CNC needs at least one active Owner."',
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(STALE_OR_TAKEN)
  update(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: UpdateStaffRequest,
    @Req() httpRequest: Request,
  ): Promise<StaffPersonResponse> {
    return this.people.update(actor, id, request, clientAddressOf(httpRequest));
  }

  @Post(':id/photo')
  @HttpCode(HttpStatus.OK)
  @PhotoUpload()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffPeopleReplacePhoto',
    summary: 'Replace a staff photograph (staff.photo)',
    description:
      'Your own, or anyone’s as a manager. Multipart: the file in `photo`, ' +
      'the account’s `version` beside it. Judged by its bytes, cropped to a ' +
      'square of at most 320 pixels with every piece of metadata removed, ' +
      'and stored privately; the response carries a short-lived signed ' +
      'link.',
  })
  @ApiResponse({ status: 200, type: StaffPersonResponse })
  @ApiResponse({
    status: 400,
    description: 'No file, a bad version, or an image too large to decode.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description: '"You can update only your own photograph."',
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(STALE_OR_TAKEN)
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
  ): Promise<StaffPersonResponse> {
    return this.people.replacePhoto(
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
    operationId: 'staffPeopleRemovePhoto',
    summary: 'Remove a staff photograph (staff.photo)',
    description: 'Your own, or anyone’s as a manager.',
  })
  @ApiResponse({ status: 200, type: StaffPersonResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description: '"You can update only your own photograph."',
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(STALE_OR_TAKEN)
  removePhoto(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: VersionedWriteDto,
    @Req() httpRequest: Request,
  ): Promise<StaffPersonResponse> {
    return this.people.removePhoto(
      actor,
      id,
      request.version,
      clientAddressOf(httpRequest),
    );
  }

  @Post(':id/qr/regenerate')
  @HttpCode(HttpStatus.OK)
  @Roles()
  @ApiParam(ID_PARAM)
  @ApiOperation({
    operationId: 'staffPeopleRegenerateQr',
    summary: 'Reissue a staff ID',
    description:
      'Managers only; a Manager or Owner account only by the Owner. A new ' +
      'QR code replaces the old one, which stops working at once; the ' +
      'staff number and attendance history are kept. The code is never ' +
      'returned: print the new card from the card view.',
  })
  @ApiResponse({ status: 200, type: StaffPersonResponse })
  @ApiResponse({
    status: 400,
    description: 'A bad version.',
    type: ApiErrorResponse,
  })
  @ApiResponse(UNAUTHORISED)
  @ApiResponse({
    status: 403,
    description: 'Not a manager, or a Manager reissuing a Manager or Owner ID.',
    type: ApiErrorResponse,
  })
  @ApiResponse(NOT_FOUND)
  @ApiResponse(STALE_OR_TAKEN)
  regenerateQr(
    @CurrentStaff() actor: StaffPrincipal,
    @Param('id') id: string,
    @Body() request: VersionedWriteDto,
    @Req() httpRequest: Request,
  ): Promise<StaffPersonResponse> {
    return this.people.regenerateQr(
      actor,
      id,
      request.version,
      clientAddressOf(httpRequest),
    );
  }
}
